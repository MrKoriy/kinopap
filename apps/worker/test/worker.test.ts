import { describe, expect, it } from "vitest";
import type { Job } from "bullmq";
import {
  handleJob,
  type IngestJobStore,
  type WorkerDeps,
} from "../src/worker";
import { ingestJobSchema, transcodeJobPayloadSchema } from "../src/queue";

function fakeStore() {
  const calls: string[] = [];
  const store: IngestJobStore = {
    markRunning: async (id) => {
      calls.push(`running:${id}`);
    },
    markDone: async (id, r) => {
      calls.push(`done:${id}:${r.itemId}:${r.mediaId}`);
    },
    markFailed: async (id, e) => {
      calls.push(`failed:${id}:${e}`);
    },
  };
  return { store, calls };
}

function fakeDeps(overrides: Partial<WorkerDeps> = {}) {
  const { store, calls } = fakeStore();
  const deps: WorkerDeps = {
    jobStore: store,
    runIngest: async (job) => ({ itemId: 10, mediaId: 20 }),
    runProbe: async () => ({
      ref: "x",
      container: "mp4",
      durationSeconds: 1,
      video: [],
      audio: [],
      subtitles: [],
    }),
    runTranscode: async () => ({ keys: ["a/720p/index.m3u8"] }),
    ...overrides,
  };
  return { deps, calls };
}

function asJob(data: unknown): Job {
  return { data, id: "1", name: "t" } as unknown as Job;
}

describe("queue schemas", () => {
  it("валидирует ingest payload из api-client контрактов", () => {
    const parsed = ingestJobSchema.parse({
      kind: "ingest",
      jobId: 5,
      source: { type: "local", ref: "movie.mkv" },
      item: { title: "Матрица", year: 1999 },
    });
    expect(parsed.item.type).toBe("movie");
    expect(
      transcodeJobPayloadSchema.safeParse({ kind: "ingest", jobId: 0 }).success,
    ).toBe(false);
  });
});

describe("handleJob", () => {
  it("dispatches probe и transcode", async () => {
    const { deps } = fakeDeps();
    const probed = (await handleJob(
      deps,
      asJob({ kind: "probe", sourceKey: "k.mp4" }),
    )) as { ref: string };
    expect(probed.ref).toBe("x");

    const transcoded = (await handleJob(
      deps,
      asJob({ kind: "transcode", sourceKey: "k.mp4" }),
    )) as { keys: string[] };
    expect(transcoded.keys).toEqual(["a/720p/index.m3u8"]);
  });

  it("ingest проходит статусы running → done", async () => {
    const { deps, calls } = fakeDeps();
    const result = await handleJob(
      deps,
      asJob({
        kind: "ingest",
        jobId: 7,
        source: { type: "local", ref: "movie.mkv" },
        item: { title: "Матрица" },
      }),
    );
    expect(result).toEqual({ itemId: 10, mediaId: 20 });
    expect(calls).toEqual(["running:7", "done:7:10:20"]);
  });

  it("ingest при ошибке пишет failed и пробрасывает", async () => {
    const { deps, calls } = fakeDeps({
      runIngest: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      handleJob(
        deps,
        asJob({
          kind: "ingest",
          jobId: 8,
          source: { type: "url", ref: "http://x/y.mkv" },
          item: { title: "X" },
        }),
      ),
    ).rejects.toThrow("boom");
    expect(calls[0]).toBe("running:8");
    expect(calls[1]).toMatch(/^failed:8:Error: boom/);
  });

  it("отклоняет мусорный payload", async () => {
    const { deps } = fakeDeps();
    await expect(handleJob(deps, asJob({ kind: "nope" }))).rejects.toThrow();
  });
});
