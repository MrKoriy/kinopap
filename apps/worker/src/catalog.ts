/**
 * Отдельная очередь наполнения каталога.
 *
 * Сознательно не в общую очередь транскода: fill идёт минутами, и пока он
 * крутится, ingest-задачи не должны стоять в очереди по транскоду — иначе
 * «залить 20к тайтлов» временно ломает добавление нового видео.
 */

import type { FillProgress, FillSpec, FillSummary } from "@zal/ingest";
import { type ConnectionOptions, type Job, Worker } from "bullmq";
import { z } from "zod";

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

/**
 * Зеркало спеки discovery из apps/api/src/routes/discovery.ts: та джоба
 * приходит из очереди, а не из HTTP-запроса — валидируем до запуска
 * fill, мусорную спеку логируем и подтверждаем, не вали процесс.
 * Границы значений совпадают с api-схемой.
 */
export const catalogFillSpecSchema = z.object({
  years: z.array(z.number().int().min(1950).max(2035)).max(90).optional(),
  yearPages: z.number().int().min(1).max(10).optional(),
  minVotesMovie: z.number().int().min(0).max(500).optional(),
  minVotesTv: z.number().int().min(0).max(500).optional(),
  genreMatrix: z.boolean().optional(),
  genrePages: z.number().int().min(1).max(5).optional(),
  collections: z.array(z.string().min(1).max(120)).max(150).optional(),
  lists: z.boolean().optional(),
  countries: z.array(z.string().length(2)).max(30).optional(),
  countryPages: z.number().int().min(1).max(5).optional(),
  anime: z.boolean().optional(),
  animeLimit: z.number().int().min(1).max(5000).optional(),
  dedupe: z.boolean().optional(),
});

export async function handleCatalogJob(
  deps: CatalogFillDeps,
  job: Job<CatalogJobSpec>,
): Promise<FillSummary | null> {
  const parsed = catalogFillSpecSchema.safeParse(job.data?.spec);
  if (!parsed.success) {
    // Невалидная джоба: подтверждаем (acknowledge), fill не запускаем.
    console.warn(
      `catalog: job ${job.id ?? "?"} acked with invalid spec:`,
      JSON.stringify(parsed.error.issues).slice(0, 300),
    );
    return null;
  }
  return deps.runCatalogFill(parsed.data, (progress) => {
    void job.updateProgress(progress).catch(() => {});
  });
}

export function createCatalogWorker(
  connection: ConnectionOptions,
  deps: CatalogFillDeps,
) {
  return new Worker<CatalogJobSpec>(
    CATALOG_QUEUE,
    async (job: Job<CatalogJobSpec>) => handleCatalogJob(deps, job),
    { connection, concurrency: 1 },
  );
}
