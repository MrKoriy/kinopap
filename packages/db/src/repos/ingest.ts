/**
 * Управление ingest-задачами: статусы queued → running → done/failed.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { ingestJobs, type IngestJobStatus } from "../schema/index";

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
