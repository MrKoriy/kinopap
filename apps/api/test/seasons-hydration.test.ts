/**
 * Ленивая гидрация сезонов: сериал из заливки (без эпизодов) при первом
 * открытии карточки получает сезоны/эпизоды/media из TMDb и навсегда
 * остаётся с ними в БД. Сбои источника кэшируются, чтобы не долбить TMDb.
 */
import { items, seasons } from "@zal/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./setup";

const TMDB_SHOW = {
  seasons: [
    { season_number: 0, name: "Спецвыпуски", episode_count: 2 },
    { season_number: 1, name: "Сезон 1", episode_count: 2 },
  ],
};

const TMDB_SEASON_1 = {
  episodes: [
    { episode_number: 1, name: "Пилот", runtime: 45, still_path: "/pil.jpg" },
    { episode_number: 2, name: "Вторая", runtime: 44, still_path: null },
    { episode_number: 0, name: "Спецвыпуск", runtime: 30 },
  ],
};

let app: Awaited<ReturnType<typeof createTestApp>>["app"];
let db: Awaited<ReturnType<typeof createTestApp>>["db"];
let serialId: number;
const realFetch = global.fetch;
let fetchCount = 0;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    fetchCount += 1;
    if (url.includes("/tv/4248/season/1")) {
      return new Response(JSON.stringify(TMDB_SEASON_1), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/tv/4248")) {
      return new Response(JSON.stringify(TMDB_SHOW), {
        headers: { "content-type": "application/json" },
      });
    }
    // Любой другой id — источник молчит (негативный кэш).
    return new Response("boom", { status: 500 });
  });

  const testApp = await createTestApp({ env: { TMDB_API_KEY: "test-key" } });
  app = testApp.app;
  db = testApp.db;
  const [serial] = await db
    .insert(items)
    .values({
      type: "serial",
      title: "Сериал без серий",
      year: 2025,
      tmdbId: 4248,
      quality: 1080,
    })
    .returning();
  serialId = serial!.id;
});

afterAll(() => {
  vi.unstubAllGlobals();
  global.fetch = realFetch;
});

describe("гидрация сезонов сериала", () => {
  it("первое открытие подтягивает сезоны, эпизоды и media", async () => {
    const res = await app.inject({ url: `/v1/items/${serialId}` });
    expect(res.statusCode).toBe(200);
    const item = res.json() as {
      seasons: Array<{
        number: number;
        episodes: Array<{ number: number; mediaId: number | null; title: string | null }>;
      }>;
    };

    // Спецвыпуск (сезон 0) не создаём — только сезон 1 с двумя сериями.
    expect(item.seasons.length).toBe(1);
    expect(item.seasons[0]!.number).toBe(1);
    const eps = item.seasons[0]!.episodes;
    expect(eps.map((e) => e.number)).toEqual([1, 2]);
    expect(eps[0]!.title).toBe("Пилот");
    // У каждой серии есть media — серия кликабельна, резолвер получит sXXeYY.
    expect(eps.every((e) => (e.mediaId ?? 0) > 0)).toBe(true);
  });

  it("второе открытие не ходит в TMDb — сезоны уже в БД", async () => {
    const before = fetchCount;
    const res = await app.inject({ url: `/v1/items/${serialId}` });
    expect(res.statusCode).toBe(200);
    expect(fetchCount).toBe(before);

    const seasonRows = await db.select().from(seasons).where(eq(seasons.itemId, serialId));
    expect(seasonRows.length).toBe(1);
  });
});
