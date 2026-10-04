/**
 * Свои нарезки постеров/бэкдропов: очередь воркера и запись результата.
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { items } from "../schema/index";

export interface ImageBackfillRow {
  id: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
}

const needsImages = () =>
  and(
    isNull(items.imagesCheckedAt),
    or(sql`${items.posterMedium} is not null`, sql`${items.posterBig} is not null`, sql`${items.backdropUrl} is not null`),
  );

/** Тайтлы без своих картинок: популярные первыми (их видят чаще всего). */
export async function listItemsMissingImages(db: Db, limit: number): Promise<ImageBackfillRow[]> {
  const rows = await db
    .select({
      id: items.id,
      title: items.title,
      posterMedium: items.posterMedium,
      posterBig: items.posterBig,
      backdrop: items.backdropUrl,
    })
    .from(items)
    .where(needsImages())
    .orderBy(desc(items.views), items.id)
    .limit(limit);
  return rows.map((r) => ({ id: r.id, title: r.title, poster: r.posterBig ?? r.posterMedium, backdrop: r.backdrop }));
}

export async function countItemsMissingImages(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(items).where(needsImages());
  return rows[0]?.n ?? 0;
}

export interface ItemImagesPatch {
  posterHash?: string | null;
  backdropHash?: string | null;
  posterBlurhash?: string | null;
  dominantColor?: string | null;
}

/** Результат нарезки; images_checked_at ставится всегда — и при неудаче. */
export async function setItemImages(db: Db, itemId: number, patch: ItemImagesPatch): Promise<void> {
  const set: Partial<typeof items.$inferInsert> = { imagesCheckedAt: new Date() };
  for (const [k, v] of Object.entries(patch) as Array<[keyof ItemImagesPatch, string | null | undefined]>) {
    if (v !== undefined) set[k] = v;
  }
  await db.update(items).set(set).where(eq(items.id, itemId));
}

/** Постер/бэкдроп сменился у источника — нарезать заново. */
export async function resetItemImages(db: Db, itemId: number): Promise<void> {
  await db.update(items).set({ imagesCheckedAt: null }).where(eq(items.id, itemId));
}
