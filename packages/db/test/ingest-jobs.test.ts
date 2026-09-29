import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createIngestJob,
  ingestJobs,
  isUniqueViolationError,
  reconcileStaleIngestJobs,
} from "../src";
import { createTestDb } from "./helpers";

describe("partial unique: одна активная задача на источник", () => {
  it("второй активный дубль отклоняется БД (23505)", async () => {
    const db = await createTestDb();
    const first = await createIngestJob(db, { sourceType: "local", sourceRef: "a.mkv" });

    let dupErr: unknown = null;
    try {
      await createIngestJob(db, { sourceType: "local", sourceRef: "a.mkv" });
    } catch (err) {
      dupErr = err;
    }
    // Гонка двух POST /v1/ingest: БД отклоняет дубль, репо-хелпер узнаёт его.
    expect(dupErr).toBeTruthy();
    expect(isUniqueViolationError(dupErr)).toBe(true);

    // Другой источник — можно.
    const other = await createIngestJob(db, { sourceType: "local", sourceRef: "b.mkv" });
    expect(other.id).toBeGreaterThan(first.id);
  });

  it("после done/failed источник снова свободен", async () => {
    const db = await createTestDb();
    await createIngestJob(db, { sourceType: "tmdb", sourceRef: "movie/123" });

    const rows = await db.select().from(ingestJobs);
    await db
      .update(ingestJobs)
      .set({ status: "done" })
      .where(eq(ingestJobs.id, rows[0]!.id));

    // История (done) не мешает поставить новую активную задачу.
    const again = await createIngestJob(db, { sourceType: "tmdb", sourceRef: "movie/123" });
    expect(again.status).toBe("queued");

    // И failed тоже.
    await db
      .update(ingestJobs)
      .set({ status: "failed" })
      .where(eq(ingestJobs.id, again.id));
    await createIngestJob(db, { sourceType: "tmdb", sourceRef: "movie/123" });
  });

  it("разные source_ref при одном source_type не конфликтуют", async () => {
    const db = await createTestDb();
    await createIngestJob(db, { sourceType: "local", sourceRef: "x.mkv" });
    await createIngestJob(db, { sourceType: "local", sourceRef: "y.mkv" });
    const rows = await db.select().from(ingestJobs);
    expect(rows).toHaveLength(2);
  });
});

describe("reconcileStaleIngestJobs", () => {
  it("помечает застрявшие running/queued, свежие не трогает", async () => {
    const db = await createTestDb();
    const [stale] = await db
      .insert(ingestJobs)
      .values({ sourceType: "local", sourceRef: "a.mkv", status: "running" })
      .returning();
    const [fresh] = await db
      .insert(ingestJobs)
      .values({ sourceType: "local", sourceRef: "b.mkv", status: "running" })
      .returning();
    // Застрявшая задача «не трогалась» больше часа.
    await db
      .update(ingestJobs)
      .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(ingestJobs.id, stale!.id));

    const n = await reconcileStaleIngestJobs(db);
    expect(n).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(ingestJobs);
    const staleRow = rows.find((r) => r.id === stale!.id)!;
    const freshRow = rows.find((r) => r.id === fresh!.id)!;
    expect(staleRow.status).toBe("failed");
    expect(staleRow.error).toContain("reconciled: stuck running");
    expect(freshRow.status).toBe("running");
  });
});
