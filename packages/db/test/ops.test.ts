/**
 * Выборки Catalog Daemon: подзапрос числа серий коррелирован с items
 * (раньше "id" внутри подзапроса цеплялся к seasons/episodes → ambiguous).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { episodes, items, listItemsForTmdbRefresh, listItemsWithMetadataGaps, seasons } from "../src/index";
import { createTestDb, type TestDb } from "./helpers";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  const [serial] = await db
    .insert(items)
    .values({ type: "serial", title: "Сериал", tmdbId: 501, tmdbType: "tv", views: 5 })
    .returning();
  const [s] = await db.insert(seasons).values({ itemId: serial!.id, number: 1 }).returning();
  await db.insert(episodes).values([
    { seasonId: s!.id, number: 1 },
    { seasonId: s!.id, number: 2 },
  ]);
  await db.insert(items).values({ type: "movie", title: "Фильм", tmdbId: 777, tmdbType: "movie", views: 1 });
});

describe("ops: выборки демона", () => {
  it("listItemsForTmdbRefresh считает серии своего тайтла", async () => {
    const rows = await listItemsForTmdbRefresh(db, "tv", [501, 999]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tmdbId: 501, tmdbType: "tv", episodes: 2 });
  });

  it("listItemsWithMetadataGaps отдаёт тайтлы без бэкдропа/описания", async () => {
    const rows = await listItemsWithMetadataGaps(db, 10);
    expect(rows.map((r) => r.tmdbId).sort()).toEqual([501, 777]);
    expect(rows.find((r) => r.tmdbId === 777)?.episodes).toBe(0);
  });
});
