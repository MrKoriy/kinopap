import { createDb, createPool, reconcileStaleIngestJobs, recordError } from "@zal/db";
import { fillCatalog, stopActiveChildren } from "@zal/ingest";
import { parseSentryDsn, sendSentryEvent } from "@zal/shared";
import { Redis } from "ioredis";
import { runScript, startAutopilot } from "./autopilot";
import { createCatalogWorker } from "./catalog";
import { startCatalogDaemon } from "./daemon";
import { makeWorkerDeps } from "./deps";
import { startRevalidator } from "./lib/revalidate";
import { startNotify } from "./notify";
import { startStreamJobs } from "./stream-jobs";
import { createTranscoderWorker } from "./worker";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(createPool(databaseUrl));

// Необработанные ошибки — в ленту Ops (и Sentry при SENTRY_DSN), а не только в лог.
const sentry = parseSentryDsn(process.env.SENTRY_DSN);
function reportFatal(kind: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const input = { source: "worker" as const, message: `${kind}: ${e.name}: ${e.message}`, stack: e.stack ?? null, release: process.env.RELEASE ?? null };
  void recordError(db, input).catch(() => undefined);
  void sendSentryEvent(sentry, { ...input, platform: "node", tags: { source: "worker" } });
}
process.on("unhandledRejection", (err) => {
  console.warn("worker: unhandled rejection:", String(err).slice(0, 300));
  reportFatal("unhandledRejection", err);
});

// Краш воркера посреди encode раньше оставлял ingest_jobs навсегда «running».
// SQL сужают до running-only — просто вызываем, сигнатура не меняется.
async function reconcileStale(): Promise<void> {
  try {
    const reconciled = await reconcileStaleIngestJobs(db);
    if (reconciled > 0) {
      console.log(`worker: reconciled ${reconciled} stale ingest jobs`);
    }
  } catch (err) {
    console.warn("worker: reconcile failed:", String(err).slice(0, 200));
  }
}
await reconcileStale();

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

// Автопилот: свежие релизы, новые серии аниме, трейлеры — по расписанию.
if (process.env.AUTOPILOT !== "0" && tmdbApiKey) {
  const autopilotConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  autopilotConnection.on("error", (err) => {
    console.warn("worker: autopilot redis error (non-fatal):", String(err).slice(0, 300));
  });
  void startAutopilot(autopilotConnection).catch((err) => {
    console.warn("worker: autopilot failed to start (non-fatal):", String(err).slice(0, 300));
  });
}

// Catalog Daemon: TMDb /changes и ленты новинок, свежие серии AniLibria,
// дыры метаданных и картинки новых тайтлов — по расписанию (src/daemon.ts).
let stopDaemon: (() => Promise<void>) | null = null;
if (process.env.CATALOG_DAEMON !== "0" && tmdbApiKey) {
  const daemonConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  daemonConnection.on("error", (err) => {
    console.warn("worker: daemon redis error (non-fatal):", String(err).slice(0, 300));
  });
  startCatalogDaemon(daemonConnection, {
    db,
    tmdbApiKey,
    anilibriaBaseUrl: process.env.ANILIBRIA_URL,
    runScript,
  })
    .then((stop) => {
      stopDaemon = stop;
    })
    .catch((err) => {
      console.warn("worker: catalog daemon failed to start (non-fatal):", String(err).slice(0, 300));
    });
}

// Уведомления о новых сериях (Telegram, web push) и алерты Ops. NOTIFY=0 — выкл.
let stopNotify: (() => Promise<void>) | null = null;
if (process.env.NOTIFY !== "0") {
  const notifyConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  notifyConnection.on("error", (err) => {
    console.warn("worker: notify redis error (non-fatal):", String(err).slice(0, 300));
  });
  const vapidPublic = process.env.WEBPUSH_PUBLIC_KEY;
  const vapidPrivate = process.env.WEBPUSH_PRIVATE_KEY;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.PUBLIC_SITE_URL || "http://localhost:3000";
  startNotify(notifyConnection, db, {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    webpush:
      vapidPublic && vapidPrivate
        ? { publicKey: vapidPublic, privateKey: vapidPrivate, subject: process.env.WEBPUSH_SUBJECT || siteUrl }
        : undefined,
    siteUrl,
  })
    .then((stop) => {
      stopNotify = stop;
    })
    .catch((err) => {
      console.warn("worker: notify failed to start (non-fatal):", String(err).slice(0, 300));
    });
}

// Точечный сброс ISR веба: изменившиеся тайтлы → revalidateTag. Включается
// секретом, общим с вебом (REVALIDATE_SECRET в /opt/kinopap/.env).
let stopRevalidator: (() => void) | undefined;
if (process.env.REVALIDATE_SECRET) {
  const revalidateConnection = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  revalidateConnection.on("error", (err) => {
    console.warn("worker: revalidate redis error (non-fatal):", String(err).slice(0, 300));
  });
  stopRevalidator = startRevalidator({
    db,
    redis: revalidateConnection,
    webUrl: process.env.WEB_INTERNAL_URL ?? "http://127.0.0.1:7000",
    secret: process.env.REVALIDATE_SECRET,
    everyMs: Number(process.env.REVALIDATE_EVERY_S ?? 120) * 1000,
  });
  console.log("worker: revalidate loop ready");
}

// Старт видео без скрейпа: stream-precheck (раздачи заранее) и прогрев
// голов файлов топ-N в TorrServer. Выключается STREAM_PRECHECK=0.
let stopStreamJobs: (() => Promise<void>) | null = null;
if (process.env.STREAM_PRECHECK !== "0") {
  const streamConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  streamConnection.on("error", (err) => {
    console.warn("worker: stream redis error (non-fatal):", String(err).slice(0, 300));
  });
  startStreamJobs(streamConnection, db)
    .then((stop) => {
      stopStreamJobs = stop;
    })
    .catch((err) => {
      console.warn("worker: stream jobs failed to start (non-fatal):", String(err).slice(0, 300));
    });
}

// BullMQ-воркеры и Redis-коннекты эмитят 'error' (сбой jobs, реконнект).
// Без слушателя an unhandled 'error' роняет процесс — падение Redis
// не должно убивать воркера, оно должно попадать в лог и ретраиться.
for (const [name, w] of [
  ["transcode", worker],
  ["catalog", catalogWorker],
] as const) {
  w.on("error", (err) => {
    console.warn(`worker: ${name} worker error (non-fatal):`, String(err).slice(0, 300));
  });
}
for (const [name, c] of [
  ["transcode", connection],
  ["catalog", catalogConnection],
] as const) {
  c.on("error", (err) => {
    console.warn(`worker: ${name} redis error (non-fatal):`, String(err).slice(0, 300));
  });
}

// GC по расписанию: раньше чистка шла только после успешного ingest,
// и «тихий» воркер без джоб копил сироты вечно. Раз в час достаточно.
const GC_INTERVAL_MS = 60 * 60 * 1000;
const gcTimer = setInterval(() => {
  void deps.gc?.().catch((err) => {
    console.warn("worker: scheduled gc failed (non-fatal):", String(err).slice(0, 200));
  });
}, GC_INTERVAL_MS);
gcTimer.unref();

// Реконсиляция «running»-джоб: не только на старте — краш между
// стартами воркера висел бы до следующего рестарта. Раз в 15 минут.
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const reconcileTimer = setInterval(() => void reconcileStale(), RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

async function shutdown(signal: string): Promise<void> {
  console.log(`worker: ${signal}, closing`);
  clearInterval(gcTimer);
  clearInterval(reconcileTimer);
  stopRevalidator?.();
  // Потолок ожидания: зависший encode держал worker.close() бесконечно,
  // PM2 завершал процесс принудительно, ffmpeg оставался сиротой.
  const exitTimer = setTimeout(() => process.exit(1), 10_000);
  exitTimer.unref();
  // Сначала останавливаем дочерние ffmpeg/ffprobe — иначе close() ждёт
  // завершения активной джобы часами.
  await stopActiveChildren(5_000);
  await Promise.allSettled([worker.close(), catalogWorker.close(), stopStreamJobs?.(), stopDaemon?.(), stopNotify?.()]);
  await Promise.allSettled([connection.quit(), catalogConnection.quit()]);
  clearTimeout(exitTimer);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
