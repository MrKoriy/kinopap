import { describe, expect, it } from "vitest";
import {
  probeJobSchema,
  transcodeJobPayloadSchema,
  transcodeJobSchema,
} from "../src/queue";

describe("transcode job schemas", () => {
  it("accepts probe and transcode payloads", () => {
    const probe = probeJobSchema.parse({
      kind: "probe",
      mediaId: 1,
      sourceKey: "uploads/movie.mkv",
    });
    expect(probe.kind).toBe("probe");

    const transcode = transcodeJobSchema.parse({
      kind: "transcode",
      mediaId: 1,
      sourceKey: "uploads/movie.mkv",
      ladders: ["720p", "1080p"],
    });
    expect(transcode.ladders).toEqual(["720p", "1080p"]);
  });

  it("applies default ladder", () => {
    const job = transcodeJobSchema.parse({
      kind: "transcode",
      mediaId: 2,
      sourceKey: "uploads/x.mkv",
    });
    expect(job.ladders).toEqual(["720p", "1080p"]);
  });

  it("rejects garbage payloads", () => {
    expect(transcodeJobPayloadSchema.safeParse({ kind: "unknown" }).success).toBe(false);
    expect(
      transcodeJobSchema.safeParse({
        kind: "transcode",
        mediaId: -1,
        sourceKey: "",
      }).success,
    ).toBe(false);
    expect(
      transcodeJobSchema.safeParse({
        kind: "transcode",
        mediaId: 1,
        sourceKey: "a.mkv",
        ladders: ["4k-ultra"],
      }).success,
    ).toBe(false);
  });
});
