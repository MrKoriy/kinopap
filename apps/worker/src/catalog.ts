/**
 * Отдельная очередь наполнения каталога.
 *
 * Сознательно не в общую очередь транскода: fill идёт минутами, и пока он
 * крутится, ingest-задачи не должны стоять в очереди по транскоду — иначе
 * «залить 20к тайтлов» временно ломает добавление нового видео.
 */

import type { FillProgress, FillSpec, FillSummary } from "@zal/ingest";
import { type ConnectionOptions, type Job, Worker } from "bullmq";

export const CATALOG_QUEUE = "catalog";

export interface CatalogJobSpec {
  spec: FillSpec;
}

export interface CatalogFillDeps {
  runCatalogFill: (
    spec: FillSpec,
    onProgress: (p: FillProgress) => void,
  ) => Promise<FillSummary>;
}

export function createCatalogWorker(
  connection: ConnectionOptions,
  deps: CatalogFillDeps,
) {
  return new Worker<CatalogJobSpec>(
    CATALOG_QUEUE,
    async (job: Job<CatalogJobSpec>) => {
      const summary = await deps.runCatalogFill(job.data.spec, (progress) => {
        void job.updateProgress(progress).catch(() => {});
      });
      return summary;
    },
    { connection, concurrency: 1 },
  );
}
