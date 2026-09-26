import { Worker, type Job, type ConnectionOptions } from "bullmq";
import {
  TRANSCODE_QUEUE,
  transcodeJobPayloadSchema,
  type TranscodeJobPayload,
} from "./queue";

export interface TranscodeResult {
  ok: true;
  kind: TranscodeJobPayload["kind"];
  mediaId: number;
}

/**
 * Обработчик задачи. Фаза 2 подключит сюда ffprobe/ffmpeg:
 * probe → метаданные, transcode → HLS-лестница + тумбы + WebVTT.
 * Каркас валидирует payload и подтверждает приём.
 */
export async function handleJob(job: Job<TranscodeJobPayload>): Promise<TranscodeResult> {
  const payload = transcodeJobPayloadSchema.parse(job.data);
  return { ok: true, kind: payload.kind, mediaId: payload.mediaId };
}

export function createTranscoderWorker(connection: ConnectionOptions) {
  return new Worker<TranscodeJobPayload>(TRANSCODE_QUEUE, handleJob, {
    connection,
    concurrency: 1,
  });
}
