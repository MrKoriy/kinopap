/**
 * Прод-обвязка воркера: реальные коннекторы, хранилище и пайплайн.
 */

import { type Db, updateIngestJob } from "@zal/db";
import {
  type FfmpegConfig,
  gcOrphanIngestDirs,
  gcStaleTmpDirs,
  LocalFolderConnector,
  LocalStorage,
  type MediaStorage,
  type MetadataEnricher,
  runIngest,
  type SourceConnector,
  TmdbEnricher,
  UrlSourceConnector,
} from "@zal/ingest";
import type { IngestJobStore, WorkerDeps } from "./worker";

export interface WorkerDepsConfig {
  db: Db;
  /** Корень хранилища медиа (в проде — точка монтирования бакета). */
  mediaRoot: string;
  mediaBaseUrl: string;
  /** Папка с твоими файлами для LocalFolder-коннектора. */
  localSourceRoot: string;
  tmdbApiKey?: string;
  ffmpeg?: FfmpegConfig;
  fetch?: typeof fetch;
  /** URL-ингест из LAN/NAS: приватные адреса разрешены явно, не по умолчанию. */
  allowPrivateSources?: boolean;
}

export function makeWorkerDeps(cfg: WorkerDepsConfig): WorkerDeps {
  const storage: MediaStorage = new LocalStorage(cfg.mediaRoot, cfg.mediaBaseUrl);
  const connectors: Record<"local" | "url", SourceConnector> = {
    local: new LocalFolderConnector(cfg.localSourceRoot, cfg.ffmpeg),
    url: new UrlSourceConnector({
      ...cfg.ffmpeg,
      fetch: cfg.fetch,
      allowPrivateHosts: cfg.allowPrivateSources,
    }),
  };
  const enricher: MetadataEnricher | undefined = cfg.tmdbApiKey
    ? new TmdbEnricher({ apiKey: cfg.tmdbApiKey, fetch: cfg.fetch })
    : undefined;

  const jobStore: IngestJobStore = {
    markRunning: (id) => updateIngestJob(cfg.db, id, { status: "running" }),
    // Пустой патч: updateIngestJob сам освежает updatedAt.
    touch: (id) => updateIngestJob(cfg.db, id, {}),
    markDone: (id, result) =>
      updateIngestJob(cfg.db, id, {
        status: "done",
        itemId: result.itemId,
        mediaId: result.mediaId,
        // Хвост прошлых реконсиляций/ретраев не должен висеть на успехе.
        error: null,
      }),
    markFailed: (id, error) =>
      updateIngestJob(cfg.db, id, { status: "failed", error }),
  };

  return {
    jobStore,
    gc: async () => {
      // Сироты ingest/* и jobs/* в хранилище + осиротевшие zal-ingest-*
      // рабочие каталоги в tmpdir (остаются после крашей воркера).
      const removed = await gcOrphanIngestDirs(cfg.db, cfg.mediaRoot);
      const tmpRemoved = await gcStaleTmpDirs();
      if (removed.length > 0) {
        console.log(`worker gc: removed ${removed.length} orphan dirs`);
      }
      if (tmpRemoved.length > 0) {
        console.log(`worker gc: removed ${tmpRemoved.length} stale tmp dirs`);
      }
    },
    runIngest: (job) =>
      runIngest(
        {
          db: cfg.db,
          storage,
          connectors,
          enricher,
          ffmpeg: cfg.ffmpeg,
        },
        {
          source: job.source,
          item: job.item,
          ladders: job.ladders,
          episode: job.episode,
        },
      ),
  };
}
