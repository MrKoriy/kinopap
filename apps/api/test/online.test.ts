/**
 * Онлайн-балансеры: парсинг ответов Kodik/Alloha и роут /v1/items/:id/online.
 */
import { items } from "@zal/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findOnlineSources, type OnlineTarget, parseAlloha, parseKodik } from "../src/lib/balancers";
import { makeFixtures } from "./fixtures";
import { createTestApp } from "./setup";

const movie: OnlineTarget = {
  type: "movie",
  tmdbId: 603,
  tmdbType: "movie",
  imdbId: 133093,
  kinopoiskId: null,
  title: "Матрица",
  originalTitle: "The Matrix",
  year: 1999,
};

const kodikResults = {
  results: [
    { link: "//kodik.info/video/1/h/720p", type: "foreign-movie", year: 1999, quality: "BDRip 1080p", translation: { id: 1, title: "Дубляж" } },
    { link: "//kodik.info/video/2/h/720p", type: "foreign-movie", year: 1999, translation: { id: 1, title: "Дубляж" } },
    { link: "//kodik.info/video/3/h/720p", type: "foreign-movie", year: 1999, translation: { id: 2, title: "Гоблин" } },
    { link: "//kodik.info/serial/4/h/720p", type: "foreign-serial", year: 1999, translation: { id: 3, title: "LostFilm" } },
  ],
};

describe("парсеры балансеров", () => {
  it("Kodik: по озвучке одна ссылка, сериалы к фильму не липнут, https", () => {
    const out = parseKodik(kodikResults, movie, false);
    expect(out.map((s) => [s.label, s.url])).toEqual([
      ["Дубляж", "https://kodik.info/video/1/h/720p"],
      ["Гоблин", "https://kodik.info/video/3/h/720p"],
    ]);
  });

  it("Kodik по названию: год обязателен и ±1", () => {
    const far = { results: [{ link: "//k/1", type: "foreign-movie", year: 2021, translation: { id: 1, title: "A" } }] };
    expect(parseKodik(far, movie, true)).toEqual([]);
    expect(parseKodik(far, movie, false)).toHaveLength(1);
  });

  it("Alloha: success → один iframe", () => {
    expect(parseAlloha({ status: "error" })).toEqual([]);
    expect(parseAlloha({ status: "success", data: { iframe: "https://a.test/f/1", quality: "1080", last_season: "2" } })).toEqual([
      { provider: "alloha", label: "Alloha", url: "https://a.test/f/1", quality: "1080", lastSeason: 2, lastEpisode: null },
    ]);
  });

  it("findOnlineSources: Kodik по IMDb, упавший Alloha не мешает", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      if (url.includes("alloha")) throw new Error("down");
      return { ok: true, json: async () => kodikResults };
    };
    const out = await findOnlineSources({ kodikToken: "k", allohaToken: "a" }, movie, fetchImpl);
    expect(out).toHaveLength(2);
    expect(urls.some((u) => u.includes("imdb_id=tt0133093"))).toBe(true);
  });
});

describe("GET /v1/items/:id/online", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("без токенов — выключено", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    const res = await app.inject({ method: "GET", url: `/v1/items/${ids.movie}/online` });
    expect(res.json()).toEqual({ enabled: false, sources: [] });
  });

  it("IMDb-ID тянется из TMDb и сохраняется, Kodik ищется по нему", async () => {
    const { app, db } = await createTestApp({ env: { KODIK_TOKEN: "k", TMDB_API_KEY: "t" } });
    const ids = await makeFixtures(db);
    await db.update(items).set({ tmdbId: 603, tmdbType: "movie" }).where(eq(items.id, ids.movie));
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: URL | string) => {
      const url = String(u);
      seen.push(url);
      if (url.includes("/external_ids")) return new Response(JSON.stringify({ imdb_id: "tt0133093" }));
      if (url.includes("kodik-api.com")) return new Response(JSON.stringify(kodikResults));
      return new Response("{}", { status: 404 });
    });
    const res = await app.inject({ method: "GET", url: `/v1/items/${ids.movie}/online` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enabled: boolean; sources: Array<{ label: string }> };
    expect(body.enabled).toBe(true);
    expect(body.sources.map((s) => s.label)).toEqual(["Дубляж", "Гоблин"]);
    expect(seen.some((u) => u.includes("imdb_id=tt0133093"))).toBe(true);
    const [row] = await db.select({ imdbId: items.imdbId }).from(items).where(eq(items.id, ids.movie));
    expect(row?.imdbId).toBe(133093);
  });

  it("неизвестный тайтл — 404", async () => {
    const { app } = await createTestApp({ env: { KODIK_TOKEN: "k" } });
    const res = await app.inject({ method: "GET", url: "/v1/items/999999/online" });
    expect(res.statusCode).toBe(404);
  });
});
