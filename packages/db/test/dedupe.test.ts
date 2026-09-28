/**
 * Склейка дублей каталога.
 *
 * Ключевые щиты (выведены из замеров similarity на живых названиях):
 *  - «Умные дома» 2018 vs «Умный дом» 2025 — НЕ склеиваются (фильтр годов);
 *  - «Форсаж» vs «Форсаж 2» (similarity 0.78!) — НЕ склеиваются (числа);
 *  - настоящий дубль с другим годом — склеивается, связи переезжают.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  episodes,
  findDuplicatePairs,
  genres,
  itemGenres,
  items,
  media,
  mergeCatalogDuplicates,
  seasons,
} from "../src/index";
import { createTestDb } from "./helpers";

type Db = Awaited<ReturnType<typeof createTestDb>>;

async function insertItem(
  db: Db,
  values: Partial<typeof items.$inferInsert> & { title: string; year: number },
) {
  const [row] = await db.insert(items).values({ type: "movie", ...values }).returning();
  return row!;
}

describe("mergeCatalogDuplicates", () => {
  it("фильтр годов: «Умные дома» 2018 и «Умный дом» 2025 — не пара", async () => {
    const db = await createTestDb();
    await insertItem(db, { title: "Умные дома", type: "serial", year: 2018 });
    await insertItem(db, { title: "Умный дом", type: "serial", year: 2025 });

    const report = await mergeCatalogDuplicates(db, { dryRun: true });

    expect(report.candidates).toBe(0);
    expect(report.pairs).toEqual([]);
  });

  it("щит сиквелов: «Форсаж» и «Форсаж 2» сходятся по trgm, но не склеиваются", async () => {
    const db = await createTestDb();
    await insertItem(db, { title: "Форсаж", year: 2001 });
    await insertItem(db, { title: "Форсаж 2", year: 2003 });
    await insertItem(db, { title: "Форсаж: Первый рывок", year: 2003 });

    const report = await mergeCatalogDuplicates(db, { dryRun: true });

    // similarity 0.78 выше порога, а щиты (числа/префикс) отсекают все пары.
    expect(report.candidates).toBe(0);
  });

  it("dryRun находит пару, но ничего не удаляет", async () => {
    const db = await createTestDb();
    const a = await insertItem(db, { title: "Умные дома", type: "serial", year: 2018 });
    const b = await insertItem(db, { title: "Умные дома", type: "serial", year: 2019 });

    const found = await findDuplicatePairs(db);
    const report = await mergeCatalogDuplicates(db, { dryRun: true });

    expect(found.length).toBe(1);
    expect(report.candidates).toBe(1);
    expect(report.merged).toBe(0);
    const alive = await db.select({ id: items.id }).from(items);
    expect(alive.map((r) => r.id).sort((x, y) => x - y)).toEqual(
      [a.id, b.id].sort((x, y) => x - y),
    );
  });

  it("склеивает настоящий дубль: связи переезжают, жертва удаляется", async () => {
    const db = await createTestDb();
    const [genre] = await db
      .insert(genres)
      .values({ type: "movie", title: "Комедия" })
      .returning();

    // Жертва: без media, но со жанром и просмотрами.
    const victim = await insertItem(db, {
      title: "Умные дома",
      type: "serial",
      year: 2018,
      views: 10,
    });
    await db.insert(itemGenres).values({ itemId: victim.id, genreId: genre!.id });

    // Выживший: есть media — контент важнее возраста записи.
    const target = await insertItem(db, {
      title: "Умные дома",
      type: "serial",
      year: 2019,
      views: 5,
    });
    await db.insert(media).values({ itemId: target.id, title: "Основной", runtime: 40 });
    await db.insert(itemGenres).values({ itemId: target.id, genreId: genre!.id });

    const report = await mergeCatalogDuplicates(db);

    expect(report.candidates).toBe(1);
    expect(report.merged).toBe(1);

    const rows = await db
      .select({ id: items.id, year: items.year, views: items.views })
      .from(items)
      .orderBy(items.year);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(target.id);
    // Просмотры обоих сложились в выжившего.
    expect(Number(rows[0]!.views)).toBe(15);

    // Жанр один — переехал без дубля.
    const linked = await db
      .select({ id: itemGenres.genreId })
      .from(itemGenres)
      .where(eq(itemGenres.itemId, target.id));
    expect(linked.length).toBe(1);

    // media выжившего на месте.
    const mediaRows = await db
      .select({ id: media.id })
      .from(media)
      .where(eq(media.itemId, target.id));
    expect(mediaRows.length).toBe(1);
  });

  it("сезоны и эпизоды дубля переезжают, дубли эпизодов отбрасываются", async () => {
    const db = await createTestDb();
    // Выживший: больше media (2 против 1).
    const target = await insertItem(db, {
      title: "Свояки",
      type: "serial",
      year: 2020,
      views: 1,
    });
    const [tSeason] = await db
      .insert(seasons)
      .values({ itemId: target.id, number: 1, title: "Сезон 1" })
      .returning();
    const [tEp1] = await db
      .insert(episodes)
      .values({ seasonId: tSeason!.id, number: 1, title: "Пилот", runtime: 30 })
      .returning();
    await db.insert(media).values({ itemId: target.id, episodeId: tEp1!.id, runtime: 30 });
    await db.insert(media).values({ itemId: target.id, title: "Бонус", runtime: 10 });

    const victim = await insertItem(db, {
      title: "Свояки",
      type: "serial",
      year: 2021,
      views: 2,
    });
    const [vSeason] = await db
      .insert(seasons)
      .values({ itemId: victim.id, number: 1, title: "Сезон 1" })
      .returning();
    await db
      .insert(episodes)
      .values({ seasonId: vSeason!.id, number: 1, title: "Пилот", runtime: 30 });
    const [vEp2] = await db
      .insert(episodes)
      .values({ seasonId: vSeason!.id, number: 2, title: "Второй", runtime: 30 })
      .returning();
    await db.insert(media).values({ itemId: victim.id, episodeId: vEp2!.id, runtime: 30 });

    const report = await mergeCatalogDuplicates(db);
    expect(report.merged).toBe(1);

    // Жертвы больше нет, выживший держит оба эпизода первого сезона.
    const left = await db.select({ id: items.id }).from(items);
    expect(left.length).toBe(1);
    expect(left[0]!.id).toBe(target.id);

    const epRows = await db
      .select({ number: episodes.number })
      .from(episodes)
      .orderBy(episodes.number);
    expect(epRows.map((r) => r.number)).toEqual([1, 2]);

    // media выжившего целы: оба (включая переехавшее от жертвы).
    const mediaRows = await db
      .select({ id: media.id })
      .from(media)
      .where(eq(media.itemId, target.id));
    expect(mediaRows.length).toBe(3);
  });
});
