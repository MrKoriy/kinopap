/**
 * Catalog Daemon, TMDb-часть: /changes, детали → патч тайтла, ленты новинок.
 */
import { episodes, items, seasons } from "@zal/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AnilibriaConnector, detailsToPatch, fetchTmdbChangedIds, fillCatalog, refreshItemsFromTmdb, TmdbClient } from "../src";
import { createTestDb } from "./helpers";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("fetchTmdbChangedIds", () => {
  it("обходит все страницы, отбрасывает adult и не уходит дальше 14 дней", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      calls.push(url.search);
      const page = Number(url.searchParams.get("page"));
      return json({
        total_pages: 2,
        results: page === 1 ? [{ id: 1 }, { id: 2, adult: true }] : [{ id: 3 }, { id: 1 }],
      });
    }) as typeof fetch;
    const tmdb = new TmdbClient({ apiKey: "k", fetch: fetchFn, requestIntervalMs: 0 });
    const now = new Date("2026-10-05T12:00:00Z");
    const ids = await fetchTmdbChangedIds(tmdb, "movie", new Date("2026-01-01T00:00:00Z"), { now });
    expect(ids.sort()).toEqual([1, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("start_date=2026-09-22");
    expect(calls[0]).toContain("end_date=2026-10-05");
  });
});

describe("detailsToPatch", () => {
  it("сериал: рейтинг, картинки, статус и «вышли новые серии»", () => {
    const p = detailsToPatch(
      { tmdbType: "tv", externalSource: null, episodes: 10 },
      {
        vote_average: 8.26,
        vote_count: 900,
        overview: " Описание ",
        poster_path: "/p.jpg",
        backdrop_path: "/b.jpg",
        episode_run_time: [42],
        status: "Returning Series",
        number_of_episodes: 12,
      },
    );
    expect(p).toMatchObject({
      tmdbRating: 8.3,
      tmdbVotes: 900,
      rating: 8.3,
      plot: "Описание",
      posterMedium: "https://image.tmdb.org/t/p/w500/p.jpg",
      backdropUrl: "https://image.tmdb.org/t/p/w1280/b.jpg",
      runtimeAvg: 42 * 60,
      finished: false,
      episodesBehind: true,
    });
  });

  it("AniLibria-тайтл: свой рейтинг не перетираем; пустой сериал не «отстаёт»", () => {
    const p = detailsToPatch(
      { tmdbType: "tv", externalSource: "anilibria", episodes: 0 },
      { vote_average: 7, number_of_episodes: 24, status: "Ended" },
    );
    expect(p.rating).toBeNull();
    expect(p.finished).toBe(true);
    expect(p.episodesBehind).toBe(false);
  });
});

describe("refreshItemsFromTmdb", () => {
  it("новый бэкдроп сбрасывает свои нарезки, сериал помечается к догидрации", async () => {
    const db = await createTestDb();
    const [it1] = await db
      .insert(items)
      .values({
        type: "serial",
        title: "Сериал",
        tmdbId: 77,
        tmdbType: "tv",
        posterMedium: "https://image.tmdb.org/t/p/w500/p.jpg",
        posterHash: "abc",
        imagesCheckedAt: new Date(),
      })
      .returning({ id: items.id });
    const [s1] = await db.insert(seasons).values({ itemId: it1!.id, number: 1 }).returning({ id: seasons.id });
    await db.insert(episodes).values([{ seasonId: s1!.id, number: 1 }]);

    const fetchFn = (async () =>
      json({
        id: 77,
        vote_average: 7.5,
        vote_count: 10,
        poster_path: "/p.jpg",
        backdrop_path: "/new.jpg",
        number_of_episodes: 3,
      })) as typeof fetch;
    const tmdb = new TmdbClient({ apiKey: "k", fetch: fetchFn, requestIntervalMs: 0 });
    const stats = await refreshItemsFromTmdb(db, tmdb, [
      {
        id: it1!.id,
        tmdbId: 77,
        tmdbType: "tv",
        type: "serial",
        posterMedium: "https://image.tmdb.org/t/p/w500/p.jpg",
        backdropUrl: null,
        plot: null,
        runtimeAvg: null,
        externalSource: null,
        episodes: 1,
      },
    ]);
    expect(stats).toMatchObject({ checked: 1, changed: 1, images: 1, behind: 1 });
    const [row] = await db.select().from(items).where(eq(items.id, it1!.id));
    expect(row!.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/new.jpg");
    expect(row!.posterHash).toBeNull();
    expect(row!.imagesCheckedAt).toBeNull();
    expect(row!.tmdbChangedAt).not.toBeNull();
    expect(row!.tmdbRefreshedAt).not.toBeNull();
    expect(row!.tmdbRating).toBe(7.5);
  });
});

describe("fillCatalog feeds", () => {
  it("ленты новинок: низкий порог голосов и бэкдроп в карточке", async () => {
    const db = await createTestDb();
    const paths: string[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/3/movie/now_playing" && url.searchParams.get("page") === "1") {
        return json({
          results: [
            { id: 501, title: "Премьера", release_date: "2026-10-01", poster_path: "/p.jpg", backdrop_path: "/b.jpg", vote_count: 4, vote_average: 7 },
            { id: 502, title: "Без голосов", release_date: "2026-10-01", poster_path: "/p.jpg", vote_count: 0 },
          ],
        });
      }
      if (url.pathname.startsWith("/3/genre/")) return json({ genres: [] });
      return json({ results: [] });
    }) as typeof fetch;
    const res = await fillCatalog({
      db,
      apiKey: "k",
      fetch: fetchFn,
      requestIntervalMs: 0,
      spec: { feeds: true, feedPages: 1, dedupe: false },
    });
    expect(res.added).toBe(1);
    expect(paths).toEqual(expect.arrayContaining(["/3/trending/tv/day", "/3/movie/upcoming", "/3/tv/airing_today"]));
    const [row] = await db.select().from(items).where(eq(items.tmdbId, 501));
    expect(row!.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/b.jpg");
  });
});

describe("AnilibriaConnector.listLatest", () => {
  it("разбирает массив /anime/releases/latest", async () => {
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain("/anime/releases/latest?limit=2");
      return json([
        { id: 10244, year: 2026, name: { main: "Расхититель гробниц", english: "Dogulwang" }, poster: { src: "/p.jpg" } },
        { id: 0, name: { main: "мусор" } },
      ]);
    }) as typeof fetch;
    const list = await new AnilibriaConnector("https://x.test/api/v1", fetchFn).listLatest(2);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 10244, title: "Расхититель гробниц", englishTitle: "Dogulwang", year: 2026 });
  });
});
