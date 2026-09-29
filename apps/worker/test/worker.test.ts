import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { ingestJobSchema, transcodeJobPayloadSchema } from "../src/queue";
import {
  handleJob,
  type IngestJobStore,
  type WorkerDeps,
} from "../src/worker";

function fakeStore() {
  const calls: string[] = [];
  const store: IngestJobStore = {
    markRunning: async (id) => {
      calls.push(`running:${id}`);
    },
    touch: async (id) => {
      calls.push(`touch:${id}`);
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
    runIngest: async (_job) => ({ itemId: 10, mediaId: 20 }),
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

  it("ingest пульсирует touch, пока идёт длинный прогон", async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls } = fakeDeps({
        runIngest: () =>
          new Promise<{ itemId: number; mediaId: number }>((resolve) => {
            setTimeout(() => resolve({ itemId: 10, mediaId: 20 }), 11 * 60 * 1000);
          }),
      });
      const pending = handleJob(
        deps,
        asJob({
          kind: "ingest",
          jobId: 9,
          source: { type: "local", ref: "m.mkv" },
          item: { title: "X" },
        }),
      );
      // Прогон живёт 11 минут: пульс каждые 5 минут должен тикнуть дважды.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await expect(pending).resolves.toEqual({ itemId: 10, mediaId: 20 });
      expect(calls.filter((c) => c === "touch:9")).toHaveLength(2);
      expect(calls[0]).toBe("running:9");
      expect(calls.at(-1)).toBe("done:9:10:20");
      // Пульс снят с вооружения после финала — поздние тики не тикают.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(calls.filter((c) => c === "touch:9")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("мусорный payload — acknowledge без ретраев (как в catalog-очереди)", async () => {
    const { deps, calls } = fakeDeps();
    const result = await handleJob(deps, asJob({ kind: "nope" }));
    expect(result).toBeUndefined();
    // Ни один store-вызов не случился — джоба отброшена до markRunning.
    expect(calls).toEqual([]);
  });
});
