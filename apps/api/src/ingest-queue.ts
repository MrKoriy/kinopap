/**
 * Абстракция очереди ingest для API: прод кладёт задачи в BullMQ,
 * тесты — в записывающий фейк. Без очереди честно отвечаем 503.
 */
import type { IngestRequest } from "@zal/api-client";
import type { FillProgress, FillSpec, FillSummary } from "@zal/ingest";
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

/** Задача фонового наполнения каталога (отдельная от транскода очередь). */
export interface CatalogFillPayload {
  kind: "catalog-fill";
  spec: FillSpec;
}

export interface CatalogFillStatus {
  jobId: string;
  state: "queued" | "active" | "completed" | "failed" | "unknown";
  progress: FillProgress | null;
  result: FillSummary | null;
  error: string | null;
}

export interface CatalogFillQueue {
  enqueue(payload: CatalogFillPayload): Promise<{ jobId: string }>;
  status(jobId: string): Promise<CatalogFillStatus | null>;
}

/** Нет Redis — роут сам выполнит fill синхронно (dev/тесты). */
export const noopCatalogFillQueue: CatalogFillQueue = {
  async enqueue() {
    throw new HttpError(
      503,
      "catalog_fill_unavailable",
      "Catalog fill queue is not configured",
    );
  },
  async status() {
    return null;
  },
};
