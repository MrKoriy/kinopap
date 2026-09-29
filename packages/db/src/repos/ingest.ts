/**
 * Управление ingest-задачами: статусы queued → running → done/failed.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { type IngestJobStatus, ingestJobs } from "../schema/index";

export type IngestJobRow = typeof ingestJobs.$inferSelect;

/**
 * Нарушение уникальности (pg 23505): insert упёрся в partial unique index
 * ingest_jobs_active_source_uq — активная задача на источник уже есть.
 * Код смотрим и в err, и в err.cause: node-postgres кладёт его на ошибку,
 * drizzle (0.45) оборачивает ошибки в DrizzleQueryError с исходной PG-ошибкой
 * в cause; сам message обёртки «Failed query: …» кода не несёт.
 * Роуту POST /v1/ingest ловить это и отдавать 409 (существующую задачу —
 * через findActiveIngestJob).
 */
export function isUniqueViolationError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } | null };
  const pgCode = e.code ?? e.cause?.code;
  return (
    pgCode === "23505" ||
    /duplicate key/i.test(String(err)) ||
    /duplicate key/i.test(String(e.cause ?? ""))
  );
}

/**
 * Постановка задачи. Активный дубль (queued/running) на тот же
 * (source_type, source_ref) отклоняется БД — partial unique index
 * ingest_jobs_active_source_uq; ловить через isUniqueViolationError.
 */
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
