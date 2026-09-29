/**
 * BullMQ-воркер очереди транскода. Обработчики инжектируются —
 * тесты гоняют фейки, прод-обвязка идёт в deps.
 */

import { type ConnectionOptions, type Job, Worker } from "bullmq";
import { type IngestJobData, TRANSCODE_QUEUE, type TranscodeJobPayload, transcodeJobPayloadSchema } from "./queue";

export interface IngestRunResult {
  itemId: number;
  mediaId: number;
}

/** Статусы ingest-задачи в БД (очередь ↔ каталог). */
export interface IngestJobStore {
  markRunning(id: number): Promise<void>;
  /** Пульс живого прогона: многочасовой encode не должен выглядеть
   * «зависшим» для реконсиляции и дедупа постановки. */
  touch(id: number): Promise<void>;
  markDone(id: number, result: IngestRunResult): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
}

export interface WorkerDeps {
  runIngest: (job: IngestJobData) => Promise<IngestRunResult>;
  jobStore: IngestJobStore;
  /** Чистка сирот в хранилище после успешного ingest (опционально для тестов). */
  gc?: () => Promise<void>;
}

/** Ошибка задачи в БД — не бесконечный stderr ffmpeg. */
function truncateError(err: unknown): string {
  return String(err).slice(0, 4000);
}

/** Пульс ingest-прогона: реже порога реконсиляции (30 мин), чтобы
 * 15-минутный тик не гасил живой многочасовой encode в failed. */
const INGEST_HEARTBEAT_MS = 5 * 60 * 1000;

export async function handleJob(
  deps: WorkerDeps,
  job: Job<TranscodeJobPayload>,
): Promise<unknown> {
  // Мусорный payload — это навсегда: ретраи (3×30с) бессмысленны.
  // Как в catalog-очереди: лог + acknowledge. Раньше ZodError ретраилась.
  const parsed = transcodeJobPayloadSchema.safeParse(job.data);
  if (!parsed.success) {
    console.warn(
      `worker: job ${job.id} acked with invalid payload:`,
      JSON.stringify(parsed.error.issues).slice(0, 300),
    );
    return undefined;
  }
  const payload = parsed.data;

  await deps.jobStore.markRunning(payload.jobId);
  // Без пульса updatedAt трогается только на старте/финале: задача
  // старше 30 минут считалась зависшей → failed, дедуп переставал её
  // видеть и тот же источник энкодился повторно.
  const heartbeat = setInterval(() => {
    void deps.jobStore.touch(payload.jobId).catch((err) => {
      console.warn(
        "worker: heartbeat failed (non-fatal):",
        String(err).slice(0, 200),
      );
    });
  }, INGEST_HEARTBEAT_MS);
  heartbeat.unref();
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
  } finally {
    clearInterval(heartbeat);
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
