import { describe, expect, it } from "vitest";
import { ingestJobSchema, transcodeJobPayloadSchema } from "../src/queue";

describe("transcode job schemas", () => {
  it("ingest-пayload валиден целиком", () => {
    const job = ingestJobSchema.parse({
      kind: "ingest",
      jobId: 5,
      source: { type: "local", ref: "movie.mkv" },
      item: { title: "Матрица", year: 1999, ladders: ["720p", "1080p"] },
    });
    expect(job.kind).toBe("ingest");
    expect(job.jobId).toBe(5);
  });

  it("rejects garbage payloads", () => {
    expect(transcodeJobPayloadSchema.safeParse({ kind: "unknown" }).success).toBe(false);
    expect(
      ingestJobSchema.safeParse({ kind: "ingest", jobId: 0 }).success,
    ).toBe(false);
    expect(
      ingestJobSchema.safeParse({ kind: "ingest", jobId: 1, source: { type: "local" } })
        .success,
    ).toBe(false);
  });
});
