/**
 * BullMQ-воркер очереди транскода. Обработчики инжектируются —
 * тесты гоняют фейки, прод-обвязка идёт в deps.
 */

import type { SourceInfo } from "@zal/ingest";
import { type ConnectionOptions, type Job, Worker } from "bullmq";
import {
  type IngestJobData,
  type ProbeJob,
  TRANSCODE_QUEUE,
  type TranscodeJob,
  type TranscodeJobPayload,
  transcodeJobPayloadSchema,
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
  /** Чистка сирот в хранилище после успешного ingest (опционально для тестов). */
  gc?: () => Promise<void>;
}

/** Ошибка задачи в БД — не бесконечный stderr ffmpeg. */
function truncateError(err: unknown): string {
  return String(err).slice(0, 4000);
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
        // Сироты в хранилище (перезаписи дедупа, упавшие прогоны) — после
        // успешной публикации, с grace-периодом внутри GC.
        await deps.gc?.().catch((err) => {
          console.warn("worker: gc failed (non-fatal):", String(err).slice(0, 200));
        });
        return result;
      } catch (err) {
        // BullMQ ретраит задачу: «failed» ставим только на последней попытке,
        // иначе промежуточный статус врёт (running → failed → running…).
        const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
        if (isLastAttempt) {
          await deps.jobStore.markFailed(payload.jobId, truncateError(err));
        }
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
