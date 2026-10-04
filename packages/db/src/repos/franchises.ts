/**
 * Франшизы аниме (AniList): граф связей одного тайтла → упорядоченный
 * список частей. Матч частей с нашими карточками — по нормализованному
 * названию и году (±1: AniList считает по дате премьеры, TMDb — по сезону).
 */
import type { Franchise } from "@zal/api-client";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { franchiseEntries, franchises, items } from "../schema/index";

/** Нормализация названия: регистр, ё, пунктуация и пробелы — мимо. */
export function normTitle(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface FranchiseEntryInput {
  anilistId: number;
  title: string;
  format: string | null;
  year: number | null;
  episodes: number | null;
  itemId: number | null;
}

/** Повторный поиск франшизы: выходят новые сезоны. */
const ANILIST_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface AnimeCandidateRow {
  id: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
}

/**
 * Аниме, у которых ещё не искали франшизу (или давно): источник AniLibria,
 * тип anime или жанр «аниме». Популярные — первыми.
 */
export async function listAnimeForFranchise(db: Db, limit: number): Promise<AnimeCandidateRow[]> {
  const res = await db.execute<{ id: number; title: string; original_title: string | null; year: number | null }>(sql`
    select i.id, i.title, i.original_title, i.year from items i
    where (i.anilist_checked_at is null or i.anilist_checked_at < ${new Date(Date.now() - ANILIST_RETRY_MS)})
      and (
        i.type = 'anime' or i.external_source = 'anilibria'
        or exists (
          select 1 from item_genres ig join genres g on g.id = ig.genre_id
          where ig.item_id = i.id and lower(g.title) in ('аниме', 'anime')
        )
      )
    order by i.views desc nulls last, i.rating desc nulls last, i.id
    limit ${limit}
  `);
  return (res.rows as Array<{ id: number; title: string; original_title: string | null; year: number | null }>).map((r) => ({
    id: Number(r.id),
    title: r.title,
    originalTitle: r.original_title,
    year: r.year == null ? null : Number(r.year),
  }));
}

export async function markAnilistChecked(db: Db, itemIds: number[], anilistId?: number | null): Promise<void> {
  if (itemIds.length === 0) return;
  await db
    .update(items)
    .set({ anilistCheckedAt: new Date(), ...(anilistId ? { anilistId } : {}) })
    .where(inArray(items.id, itemIds));
}

export interface TitleIndexRow {
  id: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  views: number;
  type: string;
}

/**
 * Все названия каталога для матча частей франшизы. Нормализуем в JS, а не
 * регэкспом Postgres: классы символов там зависят от локали БД, и японские/
 * русские буквы в C-локали считались бы «пунктуацией». 24 тыс. строк — пара МБ.
 */
export async function loadTitleIndex(db: Db): Promise<TitleIndexRow[]> {
  return db
    .select({
      id: items.id,
      title: items.title,
      originalTitle: items.originalTitle,
      year: items.year,
      views: items.views,
      type: items.type,
    })
    .from(items);
}

/**
 * Сохраняет франшизу целиком: части перезаписываются, у сматченных карточек
 * проставляется franchise_id. Идемпотентно по anilist_root_id.
 */
export async function saveFranchise(
  db: Db,
  input: { rootAnilistId: number; title: string; entries: FranchiseEntryInput[] },
): Promise<number> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(franchises)
      .values({ anilistRootId: input.rootAnilistId, title: input.title.slice(0, 255) })
      .onConflictDoUpdate({
        target: franchises.anilistRootId,
        set: { title: input.title.slice(0, 255), updatedAt: new Date() },
      })
      .returning({ id: franchises.id });
    const franchiseId = row!.id;
    await tx.delete(franchiseEntries).where(eq(franchiseEntries.franchiseId, franchiseId));
    if (input.entries.length > 0) {
      await tx.insert(franchiseEntries).values(
        input.entries.map((e, i) => ({
          franchiseId,
          anilistId: e.anilistId,
          title: e.title.slice(0, 255),
          format: e.format,
          year: e.year,
          episodes: e.episodes,
          sortOrder: i,
          itemId: e.itemId,
        })),
      );
    }
    const itemIds = [...new Set(input.entries.map((e) => e.itemId).filter((x): x is number => x != null))];
    if (itemIds.length > 0) {
      await tx
        .update(items)
        .set({ franchiseId, anilistCheckedAt: new Date() })
        .where(inArray(items.id, itemIds));
    }
    return franchiseId;
  });
}

/** Франшиза тайтла для страницы: части по порядку выхода. */
export async function getFranchise(db: Db, franchiseId: number): Promise<Franchise | null> {
  const [f] = await db.select().from(franchises).where(eq(franchises.id, franchiseId)).limit(1);
  if (!f) return null;
  const entries = await db
    .select({
      anilistId: franchiseEntries.anilistId,
      title: franchiseEntries.title,
      format: franchiseEntries.format,
      year: franchiseEntries.year,
      episodes: franchiseEntries.episodes,
      itemId: franchiseEntries.itemId,
    })
    .from(franchiseEntries)
    .where(eq(franchiseEntries.franchiseId, franchiseId))
    .orderBy(asc(franchiseEntries.sortOrder));
  if (entries.length < 2) return null;
  return { id: f.id, title: f.title, entries };
}

/** Тайтлы без проверки AniList — для счётчика прогресса. */
export async function countAnimeUnchecked(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(
      and(
        or(eq(items.type, "anime"), eq(items.externalSource, "anilibria")),
        or(isNull(items.anilistCheckedAt), lt(items.anilistCheckedAt, new Date(Date.now() - ANILIST_RETRY_MS))),
      ),
    );
  return rows[0]?.n ?? 0;
}
