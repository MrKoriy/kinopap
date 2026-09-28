import { createDb, createPool, reconcileStaleIngestJobs } from "@zal/db";
import { fillCatalog } from "@zal/ingest";
import { Redis } from "ioredis";
import { createCatalogWorker } from "./catalog";
import { makeWorkerDeps } from "./deps";
import { createTranscoderWorker } from "./worker";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(createPool(databaseUrl));

// Краш воркера посреди encode раньше оставлял ingest_jobs навсегда «running».
const reconciled = await reconcileStaleIngestJobs(db);
if (reconciled > 0) {
  console.log(`worker: reconciled ${reconciled} stale ingest jobs`);
}

const deps = makeWorkerDeps({
  db,
  mediaRoot: process.env.MEDIA_ROOT ?? "./media",
  mediaBaseUrl: process.env.MEDIA_BASE_URL ?? "http://localhost:9000/zal-media",
  localSourceRoot: process.env.LOCAL_SOURCE_ROOT ?? "./sources",
  tmdbApiKey: process.env.TMDB_API_KEY,
  // LAN/NAS-источники разрешаются явно: ZAL_ALLOW_PRIVATE_SOURCES=1
  allowPrivateSources: process.env.ZAL_ALLOW_PRIVATE_SOURCES === "1",
  ffmpeg: {
    preset: process.env.FFMPEG_PRESET ?? "veryfast",
    crf: process.env.FFMPEG_CRF ? Number(process.env.FFMPEG_CRF) : 23,
    hlsTime: process.env.FFMPEG_HLS_TIME ? Number(process.env.FFMPEG_HLS_TIME) : 4,
    encodeTimeoutMs: process.env.FFMPEG_ENCODE_TIMEOUT_MS
      ? Number(process.env.FFMPEG_ENCODE_TIMEOUT_MS)
      : undefined,
  },
});

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const worker = createTranscoderWorker(connection, deps);
console.log("worker: started, waiting for ingest/transcode jobs");

// Очередь наполнения каталога — своя соединение и свой воркер: fill идёт
// минутами и не должен задерживать транскод.
const catalogConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const tmdbApiKey = process.env.TMDB_API_KEY;
const catalogWorker = createCatalogWorker(catalogConnection, {
  runCatalogFill: (spec, onProgress) => {
    if (!tmdbApiKey) {
      return Promise.reject(new Error("TMDB_API_KEY is required for catalog fill"));
    }
    let lastLog = 0;
    const logged = (p: Parameters<typeof onProgress>[0]) => {
      const now = Date.now();
      if (now - lastLog > 15_000 || p.phase === "done") {
        lastLog = now;
        console.log(
          `catalog-fill: ${p.phase} fetched=${p.fetched} added=${p.added} ` +
            `skipped=${p.skipped} total=${p.total}`,
        );
      }
      onProgress(p);
    };
    return fillCatalog({
      db,
      apiKey: tmdbApiKey,
      spec,
      onProgress: logged,
      anilibriaBaseUrl: process.env.ANILIBRIA_URL,
    });
  },
});
console.log("worker: catalog-fill queue ready");

async function shutdown(signal: string): Promise<void> {
  console.log(`worker: ${signal}, closing`);
  await Promise.allSettled([worker.close(), catalogWorker.close()]);
  await Promise.allSettled([connection.quit(), catalogConnection.quit()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
