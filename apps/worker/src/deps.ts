/**
 * Прод-обвязка воркера: реальные коннекторы, хранилище и пайплайн.
 */

import { type Db, updateIngestJob } from "@zal/db";
import {
  type FfmpegConfig,
  gcOrphanIngestDirs,
  LocalFolderConnector,
  LocalStorage,
  type MediaStorage,
  type MetadataEnricher,
  probeMedia,
  runIngest,
  type SourceConnector,
  TmdbEnricher,
  transcodeToHls,
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
    markDone: (id, result) =>
      updateIngestJob(cfg.db, id, {
        status: "done",
        itemId: result.itemId,
        mediaId: result.mediaId,
      }),
    markFailed: (id, error) =>
      updateIngestJob(cfg.db, id, { status: "failed", error }),
  };

  return {
    jobStore,
    gc: () =>
      gcOrphanIngestDirs(cfg.db, cfg.mediaRoot).then((removed) => {
        if (removed.length > 0) {
          console.log(`worker gc: removed ${removed.length} orphan dirs`);
        }
      }),
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
    runProbe: (job) => probeMedia(storage.resolveDir(job.sourceKey), cfg.ffmpeg),
    runTranscode: async (job) => {
      const src = storage.resolveDir(job.sourceKey);
      const info = await probeMedia(src, cfg.ffmpeg);
      const height = info.video[0]?.height ?? 720;
      const baseKey = `jobs/transcode-${Date.now()}`;
      // Multi-audio HLS: видео-лестница + рендitions дубляжей + мастер.
      const { rungs, audioRenditions } = await transcodeToHls(
        src,
        storage.resolveDir(baseKey),
        height,
        info.audio.map((a) => ({ lang: a.lang, title: a.title })),
        { ...cfg.ffmpeg, ladder: job.ladders },
      );
      return {
        keys: [
          `${baseKey}/master.m3u8`,
          ...rungs.map((r) => `${baseKey}/${r.dirName}/index.m3u8`),
          ...audioRenditions.map((a) => `${baseKey}/${a.dirName}/index.m3u8`),
        ],
      };
    },
  };
}
