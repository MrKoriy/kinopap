import {
  createDb,
  createPool,
  purgeStaleRefreshTokens,
  purgeStaleSources,
  runMigrations,
} from "@zal/db";
import {
  type FillProgress,
  type FillSummary,
  TorrServerConnector,
} from "@zal/ingest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import {
  type CatalogFillQueue,
  type IngestJobPayload,
  type IngestQueue,
  noopCatalogFillQueue,
} from "./ingest-queue";

const config = loadConfig();

const pool = createPool(config.databaseUrl);
await runMigrations(pool);
console.log("migrations: ok");

const db = createDb(pool);

// Гигиена: протухшие refresh-токены раньше не удалялись никогда.
{
  const purged = await purgeStaleRefreshTokens(db);
  if (purged > 0) console.log(`auth: purged ${purged} stale refresh tokens`);
  // Кэш резолва живёт 6 часов — старое в БД держать незачем.
  const stale = await purgeStaleSources(db, 6 * 60 * 60 * 1000);
  if (stale > 0) console.log(`resolve: purged ${stale} stale media_sources`);
}

// TorrServer: прогрев настроек буфера (read-ahead, кэш). Best-effort —
// недоступный сервер не мешает старту API, стримы резолвятся лениво.
{
  const torr = new TorrServerConnector(config.torrServerUrl, config.torrServerPublicUrl);
  const healthy = await torr.checkHealth();
  if (healthy) {
    const tuned = await torr.configureMemoryBuffer(512 * 1024 * 1024);
    console.log(`torrserver: healthy${tuned ? ", buffer tuned" : ""}`);
  } else {
    console.log("torrserver: not reachable, skipping warm-up");
  }
}

// Очередь ingest: BullMQ поверх Redis (если Redis доступен).
let ingestQueue: IngestQueue = {
  async enqueueIngest(payload: IngestJobPayload) {
    console.log("Ingest queued (memory):", payload);
  },
};

if (process.env.REDIS_URL) {
  try {
    const redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    await redis.connect();
    const queue = new Queue("transcode", { connection: redis });
    ingestQueue = {
      async enqueueIngest(payload: IngestJobPayload) {
        await queue.add("ingest", payload, {
          removeOnComplete: 100,
          // Ретраи: транзиентные сбои (сеть, падение ffmpeg) получают второй
          // шанс; failed-джобы не копятся в Redis бесконечно.
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnFail: 500,
        });
      },
    };
    console.log("redis: connected, queue ready");
  } catch (_err) {
    console.warn("redis: unavailable, running without transcode queue");
  }
}

// Очередь наполнения каталога. Своя от транскода: fill идёт минутами и не
// должен задерживать ingest. Без Redis роут выполняет fill синхронно.
let catalogQueue: CatalogFillQueue = noopCatalogFillQueue;
if (process.env.REDIS_URL) {
  try {
    const redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    await redis.connect();
    const fillQueue = new Queue("catalog", { connection: redis });
    catalogQueue = {
      async enqueue(payload) {
        const job = await fillQueue.add("fill", payload, {
          removeOnComplete: 20,
          removeOnFail: 20,
          attempts: 1,
        });
        return { jobId: String(job.id) };
      },
      async status(jobId) {
        const job = await fillQueue.getJob(jobId);
        if (!job) return null;
        const state = await job.getState();
        const mapped =
          state === "active"
            ? "active"
            : state === "completed"
              ? "completed"
              : state === "failed"
                ? "failed"
                : state === "unknown"
                  ? "unknown"
                  : "queued";
        // BullMQ отдаёт progress числом (по умолчанию 0) — наш прогресс объектом.
        const progress =
          typeof job.progress === "object" && job.progress !== null
            ? (job.progress as FillProgress)
            : null;
        return {
          jobId,
          state: mapped,
          progress,
          result: (job.returnvalue as FillSummary | null) ?? null,
          error: job.failedReason ?? null,
        };
      },
    };
    console.log("redis: catalog-fill queue ready");
  } catch (_err) {
    console.warn("redis: unavailable, catalog fill runs inline");
  }
}

const app = await buildApp({
  db,
  config,
  queue: ingestQueue,
  catalogQueue,
  logger: true,
});
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`api: listening on :${config.port}`);

// Graceful shutdown: PM2/k8s шлют SIGTERM — досыпаем in-flight запросам,
// закрываем пул PG и выходим чисто, без оборванных коннектов.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      const exitTimer = setTimeout(() => process.exit(1), 10_000);
      exitTimer.unref();
      try {
        await app.close();
        await pool.end();
      } catch {
        // Уже закрыто — выходим без шума.
      }
      process.exit(0);
    })();
  });
}
