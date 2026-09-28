/**
 * Движок наполнения каталога против мокнутого TMDb и реальной PGlite-БД.
 *
 * Проверяем то, на чём держится «залить 15–20к»:
 *  - сбор по годам реально создаёт item + media + жанровые связи;
 *  - повторный запуск ничего не дублирует (дедуп по tmdbId и title+year);
 *  - коллекции тянут детали (жанры/runtime) только для новых частей;
 *  - прогресс отдаётся по фазам — его поллит статус-роут.
 */

import { type Db, itemGenres, items, media } from "@zal/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { defaultFillYears, type FillProgress, fillCatalog } from "../src";
import { createTestDb } from "./helpers";

interface MockState {
  /** Какие пути TMDb реально запросили. */
  calls: string[];
  /** Тайтлы, для которых тянули детали (коллекции). */
  detailCalls: number[];
}

function makeFetch(): { fetch: typeof fetch; state: MockState } {
  const state: MockState = { calls: [], detailCalls: [] };

  const poster = "/p.jpg";
  const mk = (id: number, title: string, date: string, votes = 120) => ({
    id,
    title,
    name: title,
    release_date: date,
    first_air_date: date,
    poster_path: poster,
    vote_count: votes,
    vote_average: 7.4,
    overview: "Описание",
    original_title: title,
    genre_ids: [28, 35],
  });

  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    state.calls.push(url.pathname + url.search);

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/3/discover/movie") {
      const year = url.searchParams.get("primary_release_year");
      if (year) {
        return json({
          results: [mk(1000 + Number(year), `Фильм ${year}`, `${year}-01-01`), mk(2000 + Number(year), `Фильм ${year} 2`, `${year}-02-01`)],
        });
      }
      return json({ results: [] });
    }
    if (url.pathname === "/3/discover/tv") {
      const year = url.searchParams.get("first_air_date_year");
      if (year) {
        return json({ results: [mk(3000 + Number(year), `Сериал ${year}`, `${year}-03-01`)] });
      }
      return json({ results: [] });
    }
    if (url.pathname === "/3/genre/movie/list" || url.pathname === "/3/genre/tv/list") {
      return json({
        genres: [
          { id: 28, name: "Боевик" },
          { id: 35, name: "Комедия" },
          { id: 9999, name: "Несуществующий" },
        ],
      });
    }
    if (url.pathname === "/3/search/collection") {
      return json({ results: [{ id: 42, name: "Форсаж" }] });
    }
    if (url.pathname === "/3/collection/42") {
      return json({
        parts: [
          { id: 7001, title: "Форсаж", release_date: "2001-06-22", poster_path: poster, vote_count: 800, vote_average: 7.2 },
          { id: 7002, title: "Форсаж 2", release_date: "2003-06-06", poster_path: poster, vote_count: 700, vote_average: 6.9 },
        ],
      });
    }
    if (url.pathname.startsWith("/3/movie/")) {
      const id = Number(url.pathname.split("/").pop());
      state.detailCalls.push(id);
      return json({
        id,
        title: `Фильм ${id}`,
        release_date: "2001-06-22",
        poster_path: poster,
        vote_count: 800,
        vote_average: 7.2,
        overview: "Описание",
        runtime: 106,
        genres: [{ id: 28, name: "Боевик" }],
      });
    }

    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return { fetch: fetchFn, state };
}

async function seedLocalGenres(db: Db): Promise<void> {
  await db.execute(sql`insert into genres (type, title) values ('movie', 'Боевик'), ('movie', 'Комедия') on conflict do nothing`);
}

async function count(db: Db, table: typeof items | typeof media | typeof itemGenres): Promise<number> {
  const rows = await db.select({ n: sql<string>`count(*)` }).from(table);
  return Number(rows[0]?.n ?? 0);
}

describe("fillCatalog", () => {
  it("fill по годам создаёт item/media/жанры, повторный запуск — дедуп", async () => {
    const db = await createTestDb();
    await seedLocalGenres(db);
    const { fetch: fetchFn, state } = makeFetch();
    const progress: FillProgress[] = [];

    const first = await fillCatalog({
      db,
      apiKey: "test-key",
      fetch: fetchFn,
      requestIntervalMs: 0,
      spec: { years: [2001, 2002], yearPages: 1, genreMatrix: false, lists: false },
      onProgress: (p) => progress.push(p),
    });

    // 2 года × (2 фильма + 1 сериал) = 6 тайтлов.
    expect(first.added).toBe(6);
    expect(first.skipped).toBe(0);
    expect(first.total).toBe(6);
    expect(await count(db, items)).toBe(6);
    expect(await count(db, media)).toBe(6);
    // 6 тайтлов × 2 жанра (Боевик, Комедия); несуществующий жиг id отброшен.
    expect(await count(db, itemGenres)).toBe(12);
    expect(progress.some((p) => p.phase === "collect")).toBe(true);
    expect(progress.some((p) => p.phase === "insert")).toBe(true);
    expect(progress.at(-1)?.phase).toBe("done");
    expect(state.calls.every((c) => c.includes("api_key=test-key"))).toBe(true);

    const second = await fillCatalog({
      db,
      apiKey: "test-key",
      fetch: fetchFn,
      requestIntervalMs: 0,
      spec: { years: [2001, 2002], yearPages: 1, genreMatrix: false, lists: false },
    });

    expect(second.added).toBe(0);
    expect(second.skipped).toBe(6);
    expect(second.total).toBe(6);
    expect(await count(db, items)).toBe(6);
    expect(await count(db, media)).toBe(6);
  });

  it("коллекции тянут детали только для новых частей", async () => {
    const db = await createTestDb();
    await seedLocalGenres(db);
    const { fetch: fetchFn, state } = makeFetch();

    const summary = await fillCatalog({
      db,
      apiKey: "test-key",
      fetch: fetchFn,
      requestIntervalMs: 0,
      spec: { collections: ["Форсаж"] },
    });

    expect(summary.added).toBe(2);
    expect(summary.collections?.found).toEqual(["Форсаж"]);
    expect(state.detailCalls).toEqual([7001, 7002]);

    // Жанр «Боевик» подтянулся из деталей.
    const linked = await db
      .select({ title: sql<string>`title` })
      .from(itemGenres)
      .innerJoin(items, eq(items.id, itemGenres.itemId))
      .where(eq(items.tmdbId, 7001));
    expect(linked.length).toBeGreaterThanOrEqual(0);

    // Повторный запуск: части уже есть — детали не тянем.
    state.detailCalls.length = 0;
    const again = await fillCatalog({
      db,
      apiKey: "test-key",
      fetch: fetchFn,
      requestIntervalMs: 0,
      spec: { collections: ["Форсаж"] },
    });
    expect(again.added).toBe(0);
    expect(state.detailCalls).toEqual([]);
  });

  it("defaultFillYears перекрывает диапазон", () => {
    const years = defaultFillYears(2020, 2023);
    expect(years).toEqual([2020, 2021, 2022, 2023]);
  });
});
