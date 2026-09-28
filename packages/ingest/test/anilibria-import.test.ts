/**
 * Импорт AniLibria: пагинация каталога.
 *
 * Источник держит total_pages в meta.pagination ({data, meta}), а не в корне —
 * коннектор этого не видел, и импорт вставал на первой странице (50 релизов
 * из 1939). Тест ходит по двум страницам и останавливается на пустой.
 */
import { items, seasons } from "@zal/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { importAnilibriaCatalog } from "../src/anilibria-import";
import { createTestDb } from "./helpers";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("importAnilibriaCatalog", () => {
  it("листает все страницы по meta.pagination и стопается на пустой", async () => {
    const db = await createTestDb();
    const pagesSeen: number[] = [];

    const release = (id: number) => ({
      id,
      name: { main: `Релиз ${id}` },
      year: 2024,
      episodes: [
        { id: 1, ordinal: 1, name: "Серия 1", duration: 1400, hls_1080: "/hls/1.m3u8" },
        { id: 2, ordinal: 2, name: "Серия 2", duration: 1400, hls_1080: "/hls/2.m3u8" },
      ],
    });
    const pageOf = (page: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: page * 100 + i,
        name: { main: `Релиз ${page * 100 + i}` },
        year: 2024,
      }));

    const summary = await importAnilibriaCatalog({
      db,
      requestIntervalMs: 0,
      fetch: async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/anime/catalog/releases")) {
          const page = Number(url.searchParams.get("page") ?? "1");
          pagesSeen.push(page);
          if (page > 2) return jsonResponse({ data: [] });
          // total_pages только на первой странице — как у реального источника.
          return jsonResponse({
            data: pageOf(page, 50),
            meta:
              page === 1
                ? { pagination: { total_pages: 39, current_page: 1 } }
                : undefined,
          });
        }
        const rel = url.pathname.match(/\/anime\/releases\/(\d+)$/);
        if (rel) return jsonResponse(release(Number(rel[1])));
        return new Response("not found", { status: 404 });
      },
    });

    // Обе страницы пройдены, третья (пустая) остановила цикл.
    expect(pagesSeen).toEqual([1, 2, 3]);
    expect(summary.listed).toBe(100);
    expect(summary.added).toBe(100);

    // Реально созданы item + сезон для каждого релиза (плюс сид-жанры не тут).
    const count = await db.select({ id: items.id }).from(items);
    expect(count.length).toBe(100);
    const seasonRows = await db.select().from(seasons).where(eq(seasons.itemId, count[0]!.id));
    expect(seasonRows.length).toBe(1);
  });

  it("дробная спец-серия (6.5) пропускается и не роняет импорт", async () => {
    const db = await createTestDb();
    const summary = await importAnilibriaCatalog({
      db,
      requestIntervalMs: 0,
      fetch: async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/anime/catalog/releases")) {
          return jsonResponse({
            data: [{ id: 1, name: { main: "Сериал со спецвыпуском" }, year: 2024 }],
            meta: { pagination: { total_pages: 1 } },
          });
        }
        if (url.pathname.endsWith("/anime/releases/1")) {
          return jsonResponse({
            id: 1,
            name: { main: "Сериал со спецвыпуском" },
            year: 2024,
            episodes: [
              { ordinal: 1, name: "Обычная", duration: 1400 },
              { ordinal: 6.5, name: "Спецвыпуск между серий", duration: 1400 },
              { ordinal: 2, name: "Вторая", duration: 1400 },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(summary.added).toBe(1);
    // Только целые серии: 1 и 2, спец 6.5 пропущен.
    expect(summary.episodes).toBe(2);

    const itemRows = await db.select({ id: items.id }).from(items);
    expect(itemRows.length).toBe(1);
    const seasonRows = await db.select().from(seasons).where(eq(seasons.itemId, itemRows[0]!.id));
    expect(seasonRows.length).toBe(1);
  });
});
