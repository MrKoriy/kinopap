import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ingestJobs, reconcileStaleIngestJobs } from "../src";
import { createTestDb } from "./helpers";

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
