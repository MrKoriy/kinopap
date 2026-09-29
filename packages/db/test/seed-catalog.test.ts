/**
 * Сид каталога против PGlite и мокнутого TMDb.
 *
 * Прод-дыра, которую закрывает тест: сид-тайтлы обогащались через TMDb-поиск,
 * но tmdb_id не сохраняли — из-за этого у сид-сериалов не работала on-demand
 * гидрация сезонов (apps/api/src/lib/tmdb.ts), а жанр оставался единственным
 * хардкодом вместо полного набора из TMDb. Здесь проверяем оба пути: вставку
 * нового тайтла и обновление существующего (прод после деплоя).
 */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { genres, itemGenres, items, media } from "../src/schema/index";
import { seedCatalog } from "../src/seed-catalog";
import { createTestDb, type TestDb } from "./helpers";

interface MockState {
  /** Поисковые запросы (originalTitle), реально ушедшие в TMDb. */
  searchQueries: string[];
  /** Присвоенный TMDb id на каждый запрос — детерминирован, как счётчик. */
  ids: Map<string, number>;
}

/** TMDb-мок: /search отдаёт хит с жанрами, /genre/list — список жанров. */
function makeTmdbFetch(): { fetch: typeof fetch; state: MockState } {
  const state: MockState = { searchQueries: [], ids: new Map() };
  let nextId = 1000;

  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/3/search/movie" || url.pathname === "/3/search/tv") {
      const query = url.searchParams.get("query") ?? "";
      state.searchQueries.push(query);
      if (!state.ids.has(query)) state.ids.set(query, nextId++);
      return json({
        results: [
          {
            id: state.ids.get(query),
            title: query,
            name: query,
            original_title: query,
            original_name: query,
            overview: "Описание из TMDb",
            vote_average: 8.2,
            vote_count: 900,
            poster_path: "/poster.jpg",
            release_date: "2008-01-20",
            first_air_date: "2008-01-20",
            genre_ids: [18, 35, 80, 9999],
          },
        ],
      });
    }
    if (url.pathname === "/3/genre/movie/list" || url.pathname === "/3/genre/tv/list") {
      return json({
        genres: [
          { id: 18, name: "Драма" },
          { id: 35, name: "Комедия" },
          // Алиас: имя TMDb «Преступление» мапится в локальный «Криминал».
          { id: 80, name: "Преступление" },
          // Локального жанра нет — id должен отбрасываться.
          { id: 9999, name: "Несуществующий" },
        ],
      });
    }
    return json({});
  }) as typeof fetch;

  return { fetch: fetchFn, state };
}

/** Локальные жанры, как их оставляет базовый сид (packages/db/src/seed.ts). */
async function seedLocalGenres(db: TestDb): Promise<void> {
  await db
    .insert(genres)
    .values([
      { type: "movie", title: "Драма" },
      { type: "movie", title: "Комедия" },
      { type: "movie", title: "Криминал" },
      { type: "movie", title: "Триллер" },
      { type: "movie", title: "Фантастика" },
    ])
    .onConflictDoNothing();
}

async function count(
  db: TestDb,
  table: typeof items | typeof itemGenres | typeof media,
): Promise<number> {
  const rows = await db.select({ n: sql<string>`count(*)` }).from(table);
  return Number(rows[0]?.n ?? 0);
}

async function itemByTitle(db: TestDb, title: string) {
  const [row] = await db.select().from(items).where(eq(items.title, title));
  return row;
}

async function genreTitlesOf(db: TestDb, itemId: number): Promise<string[]> {
  const rows = await db
    .select({ title: genres.title })
    .from(itemGenres)
    .innerJoin(genres, eq(genres.id, itemGenres.genreId))
    .where(eq(itemGenres.itemId, itemId));
  return rows.map((r) => r.title).sort();
}

describe("seedCatalog", () => {
  it("новые тайтлы получают tmdb_id, полный набор жанров TMDb и media", async () => {
    const db = await createTestDb();
    await seedLocalGenres(db);
    const { fetch: fetchFn, state } = makeTmdbFetch();

    await seedCatalog({ db, fetch: fetchFn, tmdbKey: "test-key" });

    // Каждый сид-тайтл искался в TMDb ровно один раз — и каждый стал item'ом.
    const itemCount = await count(db, items);
    expect(state.searchQueries.length).toBe(itemCount);
    expect(itemCount).toBeGreaterThan(40);
    expect(await count(db, media)).toBe(itemCount);

    const bb = await itemByTitle(db, "Во все тяжкие");
    expect(bb).toBeDefined();
    expect(bb?.tmdbId).toBe(state.ids.get("Breaking Bad"));
    expect(bb?.plot).toBe("Описание из TMDb");
    expect(bb?.posterMedium).toContain("/w500/poster.jpg");

    // Жанры TMDb смапились в локальные (9999 без локального отброшен),
    // хардкод-фолбэк «Триллер» не нужен — жанры нашлись.
    expect(await genreTitlesOf(db, bb!.id)).toEqual(["Драма", "Комедия", "Криминал"]);

    // У каждого тайтла ровно один media-ряд.
    const mediaRows = await db
      .select({ id: media.id })
      .from(media)
      .where(eq(media.itemId, bb!.id));
    expect(mediaRows).toHaveLength(1);
  });

  it("существующему тайтлу дописывает tmdb_id и жанры, дублей не плодит", async () => {
    const db = await createTestDb();
    await seedLocalGenres(db);
    const { fetch: fetchFn, state } = makeTmdbFetch();

    // Состояние прода до фикса: «Во все тяжкие» уже сидирован, но tmdb_id нет
    // и жанр один хардкодный.
    const [old] = await db
      .insert(items)
      .values({
        type: "serial",
        title: "Во все тяжкие",
        originalTitle: "Breaking Bad",
        year: 2008,
        plot: "Хардкод из сида",
        rating: 9.5,
        quality: 2160,
        runtimeAvg: 7200,
      })
      .returning();
    await db.insert(media).values({ itemId: old.id, title: "Во все тяжкие", runtime: 7200 });
    const [thriller] = await db
      .select({ id: genres.id })
      .from(genres)
      .where(eq(genres.title, "Триллер"));
    await db.insert(itemGenres).values({ itemId: old.id, genreId: thriller!.id });

    await seedCatalog({ db, fetch: fetchFn, tmdbKey: "test-key" });

    // Обновлена та же строка, а не создана вторая.
    const rows = await db.select().from(items).where(eq(items.title, "Во все тяжкие"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(old.id);
    expect(rows[0]?.tmdbId).toBe(state.ids.get("Breaking Bad"));
    expect(rows[0]?.plot).toBe("Описание из TMDb");

    // Хардкод-жанр остался на месте, TMDb-жанры дописались сверху.
    expect(await genreTitlesOf(db, old.id)).toEqual([
      "Драма",
      "Комедия",
      "Криминал",
      "Триллер",
    ]);

    // Повторный прогон идемпотентен: ничего не дублируется.
    const itemsBefore = await count(db, items);
    const linksBefore = await count(db, itemGenres);
    await seedCatalog({ db, fetch: fetchFn, tmdbKey: "test-key" });
    expect(await count(db, items)).toBe(itemsBefore);
    expect(await count(db, itemGenres)).toBe(linksBefore);
    expect(await genreTitlesOf(db, old.id)).toEqual([
      "Драма",
      "Комедия",
      "Криминал",
      "Триллер",
    ]);
  });

  it("без ключа TMDb сеть не трогается, tmdb_id существующего не затирается", async () => {
    const db = await createTestDb();
    await seedLocalGenres(db);
    // Фетч, который падает при любом вызове: без ключа сети быть не должно.
    const failFetch = (async () => {
      throw new Error("сеть не должна трогаться без ключа");
    }) as typeof fetch;

    // Существующий тайтл с уже записанным tmdb_id (его ставил fill).
    const [existing] = await db
      .insert(items)
      .values({
        type: "serial",
        title: "Во все тяжкие",
        originalTitle: "Breaking Bad",
        year: 2008,
        plot: "Хардкод из сида",
        rating: 9.5,
        tmdbId: 4321,
      })
      .returning();

    await seedCatalog({ db, tmdbKey: null, fetch: failFetch });

    // Сбоя TMDb нет — уже записанный id не затёрт нуллом, а метаданные
    // берутся из сид-констант (как до фикса), не из сети.
    const rows = await db.select().from(items).where(eq(items.title, "Во все тяжкие"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tmdbId).toBe(4321);
    expect(rows[0]?.plot).toContain("Уолтер Уайт");
    expect(rows[0]?.plot).not.toBe("Описание из TMDb");

    // Новым тайтлам без меты достаётся хардкод-жанр, tmdb_id пуст.
    const matrix = await itemByTitle(db, "Матрица");
    expect(matrix).toBeDefined();
    expect(matrix?.tmdbId).toBeNull();
    expect(await genreTitlesOf(db, matrix!.id)).toEqual(["Фантастика"]);
    expect(existing).toBeDefined();
  });
});
