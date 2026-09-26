/**
 * BullMQ-воркер очереди транскода. Обработчики инжектируются —
 * тесты гоняют фейки, прод-обвязка идёт в deps.
 */
import { Worker, type ConnectionOptions, type Job } from "bullmq";
import type { SourceInfo } from "@zal/ingest";
import {
  TRANSCODE_QUEUE,
  transcodeJobPayloadSchema,
  type IngestJobData,
  type ProbeJob,
  type TranscodeJob,
  type TranscodeJobPayload,
} from "./queue";

export interface IngestRunResult {
  itemId: number;
  mediaId: number;
}

/** Статусы ingest-задачи в БД (очередь ↔ каталог). */
export interface IngestJobStore {
  markRunning(id: number): Promise<void>;
  markDone(id: number, result: IngestRunResult): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
}

export interface WorkerDeps {
  runIngest: (job: IngestJobData) => Promise<IngestRunResult>;
  runProbe: (job: ProbeJob) => Promise<SourceInfo>;
  runTranscode: (job: TranscodeJob) => Promise<{ keys: string[] }>;
  jobStore: IngestJobStore;
}

export async function handleJob(
  deps: WorkerDeps,
  job: Job<TranscodeJobPayload>,
): Promise<unknown> {
  const payload = transcodeJobPayloadSchema.parse(job.data);

  switch (payload.kind) {
    case "probe":
      return deps.runProbe(payload);
    case "transcode":
      return deps.runTranscode(payload);
    case "ingest": {
      await deps.jobStore.markRunning(payload.jobId);
      try {
        const result = await deps.runIngest(payload);
        await deps.jobStore.markDone(payload.jobId, result);
        return result;
      } catch (err) {
        await deps.jobStore.markFailed(payload.jobId, String(err));
        throw err;
      }
    }
  }
}

export function createTranscoderWorker(
  connection: ConnectionOptions,
  deps: WorkerDeps,
) {
  return new Worker<TranscodeJobPayload>(
    TRANSCODE_QUEUE,
    (job) => handleJob(deps, job),
    { connection, concurrency: 1 },
  );
}
