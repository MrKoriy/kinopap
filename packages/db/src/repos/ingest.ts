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

/**
 * Активная (queued/running) задача по тому же источнику — дедуп постановки:
 * повторный POST /v1/ingest не должен запускать часы повторного транскода.
 */
export async function findActiveIngestJob(
  db: Db,
  sourceType: string,
  sourceRef: string,
): Promise<IngestJobRow | null> {
  const rows = await db
    .select()
    .from(ingestJobs)
    .where(
      and(
        eq(ingestJobs.sourceType, sourceType),
        eq(ingestJobs.sourceRef, sourceRef),
        sql`${ingestJobs.status} in ('queued', 'running')`,
      ),
    )
    .orderBy(sql`${ingestJobs.id} desc`)
    .limit(1);
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
 * Реконсиляция на старте воркера: задачи в running, к которым никто
 * не прикасался дольше staleMinutes (краш воркера посреди encode,
 * потерянный BullMQ-джоб), переводятся в failed. Ждущие (queued) не
 * трогаем: при concurrency:1 очередь может копиться дольше staleMinutes,
 * и рестарт не должен помечать живые ждущие задачи failed. Возвращает
 * число погашенных задач.
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
      error: sql`coalesce(${ingestJobs.error}, '') || 'reconciled: stuck running | worker restart'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ingestJobs.status, "running"),
        lt(ingestJobs.updatedAt, cutoff),
      ),
    )
    .returning({ id: ingestJobs.id });
  return updated.length;
}
