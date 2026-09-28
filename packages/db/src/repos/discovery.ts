/**
 * Батчевая запись discovery-импорта в каталог.
 *
 * Раньше каждый тайтл стоил отдельного SELECT-дедупа и отдельных INSERT'ов
 * внутри HTTP-запроса: на 15–20к это минуты в одном запросе, который nginx
 * и так оборвёт. Здесь — один проход на батч: дедуп одним SQL по tmdbId,
 * второй проход по (title, year), затем пачечные вставки.
 */

import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import { genres, itemGenres, items, media } from "../schema/index";

/** Черновик тайтла из TMDb (жанры — id TMDb, маппинг наружу). */
export interface CatalogDraft {
  tmdbId: number;
  type: "movie" | "serial";
  title: string;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  rating: number;
  votes: number;
  runtime: number | null;
  posterSmall: string | null;
  posterMedium: string | null;
  posterBig: string | null;
  genreIds: number[];
}

export interface CatalogBatchResult {
  added: number;
  /** Уже в каталоге: пропущены, но постер/описание подтянуты при пустых. */
  skipped: number;
  /** Из пропущенных — починили пустые метаданные. */
  repaired: number;
}

/** Локальные жанры: id + название (для маппинга имён TMDb). */
export async function listLocalGenres(
  db: Db,
): Promise<Array<{ id: number; title: string; type: string }>> {
  const rows = await db
    .select({ id: genres.id, title: genres.title, type: genres.type })
    .from(genres);
  return rows.map((r) => ({ id: r.id, title: r.title, type: r.type }));
}

/**
 * Импорт одного батча черновиков.
 *
 * Дедуп: сначала по индексу `items_tmdb_id_idx`, потом по паре
 * (lower(title), year) — составной индекс `items_title_year_idx` держит
 * оба прохода без seq-scan'а на 20к строк.
 */
export async function insertCatalogBatch(
  db: Db,
  drafts: CatalogDraft[],
  tmdbToLocalGenre: Map<number, number | null>,
): Promise<CatalogBatchResult> {
  const result: CatalogBatchResult = { added: 0, skipped: 0, repaired: 0 };
  if (drafts.length === 0) return result;

  const unique = new Map<string, CatalogDraft>();
  for (const d of drafts) unique.set(`${d.type}:${d.tmdbId}`, d);
  const batch = [...unique.values()];

  // 1. Уже есть по tmdbId.
  const existingByTmdb = await db
    .select({
      id: items.id,
      tmdbId: items.tmdbId,
      posterMedium: items.posterMedium,
      plot: items.plot,
      originalTitle: items.originalTitle,
      rating: items.rating,
    })
    .from(items)
    .where(inArray(items.tmdbId, batch.map((d) => d.tmdbId)));
  const known = new Map(existingByTmdb.map((r) => [r.tmdbId as number, r]));

  const rest = batch.filter((d) => !known.has(d.tmdbId));

  // 2. Дедуп по (lower(title), year): тайтл мог прийти из другого источника
  //    (сида, прошлого fill) с тем же названием, но другим tmdbId.
  const titled = rest.filter((d) => d.year != null);
  const dupeKeys = new Set<string>();
  for (let i = 0; i < titled.length; i += 200) {
    const chunk = titled.slice(i, i + 200);
    const tuples = sql.join(
      chunk.map((d) => sql`(${d.title.toLowerCase()}, ${d.year})`),
      sql`, `,
    );
    const rows = await db
      .select({ title: items.title, year: items.year, posterMedium: items.posterMedium })
      .from(items)
      .where(sql`(lower(${items.title}), ${items.year}) IN (${tuples})`);
    for (const r of rows) dupeKeys.add(`${String(r.title).toLowerCase()}|${r.year}`);
  }

  const toInsert: CatalogDraft[] = [];
  for (const d of rest) {
    if (d.year != null && dupeKeys.has(`${d.title.toLowerCase()}|${d.year}`)) {
      result.skipped++;
      continue;
    }
    toInsert.push(d);
  }

  // 3. Ремонт метаданных у существующих (битые/пустые постера сида).
  for (const d of batch) {
    const row = known.get(d.tmdbId);
    if (!row) continue;
    result.skipped++;
    if (!row.posterMedium && d.posterMedium) {
      await db
        .update(items)
        .set({
          posterSmall: d.posterSmall,
          posterMedium: d.posterMedium,
          posterBig: d.posterBig,
          plot: d.plot,
          originalTitle: d.originalTitle,
          rating: d.rating > 0 ? d.rating : undefined,
          updatedAt: new Date(),
        })
        .where(eq(items.id, row.id));
      result.repaired++;
    }
  }

  // 4. Пачечная вставка новичков + жанры + media.
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200);
    const inserted = await db
      .insert(items)
      .values(
        chunk.map((d) => ({
          type: d.type,
          title: d.title,
          originalTitle: d.originalTitle,
          year: d.year,
          plot: d.plot,
          rating: d.rating,
          quality: 1080,
          posterSmall: d.posterSmall,
          posterMedium: d.posterMedium,
          posterBig: d.posterBig,
          tmdbId: d.tmdbId,
        })),
      )
      .returning({ id: items.id, tmdbId: items.tmdbId });

    const byTmdb = new Map(chunk.map((d, idx) => [d.tmdbId, chunk[idx]!]));
    const idByTmdb = new Map(inserted.map((r) => [r.tmdbId as number, r.id]));

    const genreRows: Array<{ itemId: number; genreId: number }> = [];
    const mediaRows: Array<{ itemId: number; title: string; runtime: number }> = [];
    for (const d of chunk) {
      const itemId = idByTmdb.get(d.tmdbId);
      if (itemId == null) continue;
      const draft = byTmdb.get(d.tmdbId);
      const seen = new Set<number>();
      for (const gid of draft?.genreIds ?? []) {
        const local = tmdbToLocalGenre.get(gid);
        if (local == null || seen.has(local)) continue;
        seen.add(local);
        genreRows.push({ itemId, genreId: local });
      }
      mediaRows.push({ itemId, title: d.title, runtime: d.runtime ?? 0 });
    }

    if (genreRows.length) {
      await db.insert(itemGenres).values(genreRows).onConflictDoNothing();
    }
    if (mediaRows.length) {
      await db.insert(media).values(mediaRows);
    }
    result.added += inserted.length;
  }

  return result;
}

/** Какие из tmdbId уже есть в каталоге — чтобы не тянуть детали чужих. */
export async function filterExistingTmdbIds(
  db: Db,
  ids: number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ tmdbId: items.tmdbId })
    .from(items)
    .where(inArray(items.tmdbId, ids));
  return new Set(rows.map((r) => r.tmdbId).filter((id): id is number => id != null));
}

/** Уже импортированные id внешнего источника (дедуп аниме и не только). */
export async function listExternalIds(
  db: Db,
  source: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ externalId: items.externalId })
    .from(items)
    .where(eq(items.externalSource, source));
  return new Set(rows.map((r) => r.externalId).filter((v): v is string => !!v));
}

/** Сколько тайтлов в каталоге — для отчёта fill-джобы. */
export async function countCatalogItems(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<string>`count(*)` }).from(items);
  return Number(rows[0]?.n ?? 0);
}
