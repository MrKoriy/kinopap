/**
 * Абстракция очереди ingest для API: прод кладёт задачи в BullMQ,
 * тесты — в записывающий фейк. Без очереди честно отвечаем 503.
 */
import type { IngestRequest } from "@zal/api-client";
import { HttpError } from "./lib/http";

export interface IngestJobPayload extends IngestRequest {
  kind: "ingest";
  jobId: number;
}

export interface IngestQueue {
  enqueueIngest(payload: IngestJobPayload): Promise<void>;
}

export const noopIngestQueue: IngestQueue = {
  async enqueueIngest() {
    throw new HttpError(
      503,
      "ingest_unavailable",
      "Ingest queue is not configured",
    );
  },
};
