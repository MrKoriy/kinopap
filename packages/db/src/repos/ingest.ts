/**
 * Управление ingest-задачами: статусы queued → running → done/failed.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { type IngestJobStatus, ingestJobs } from "../schema/index";

export type IngestJobRow = typeof ingestJobs.$inferSelect;

export async function createIngestJob(
  db: Db,
  input: { sourceType: string; sourceRef: string },
): Promise<IngestJobRow> {
  const [row] = await db
    .insert(ingestJobs)
    .values({ sourceType: input.sourceType, sourceRef: input.sourceRef })
    .returning();
  return row!;
}

export async function getIngestJob(db: Db, id: number): Promise<IngestJobRow | null> {
  const rows = await db.select().from(ingestJobs).where(eq(ingestJobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateIngestJob(
  db: Db,
  id: number,
  patch: {
    status?: IngestJobStatus;
    itemId?: number | null;
    mediaId?: number | null;
    error?: string | null;
  },
): Promise<void> {
  await db
    .update(ingestJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ingestJobs.id, id));
}

/**
 * Реконсиляция на старте воркера: задачи в running/queued, к которым никто
 * не прикасался дольше staleMinutes (краш воркера посреди encode, потерянный
 BullMQ-джоб), переводятся в failed. Возвращает число погашенных задач.
 */
export async function reconcileStaleIngestJobs(
  db: Db,
  staleMinutes = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
  const updated = await db
    .update(ingestJobs)
    .set({
      status: "failed",
      error: sql`coalesce(${ingestJobs.error}, '') || 'reconciled: stuck ' || ${ingestJobs.status} || ' | worker restart'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        sql`${ingestJobs.status} in ('running', 'queued')`,
        lt(ingestJobs.updatedAt, cutoff),
      ),
    )
    .returning({ id: ingestJobs.id });
  return updated.length;
}
