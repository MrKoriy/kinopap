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
  noopIngestQueue,
} from "./ingest-queue";
import { startGapFiller } from "./lib/gap-filler";
import { HttpError } from "./lib/http";

const config = loadConfig();

const pool = createPool(config.databaseUrl);
await runMigrations(pool);
console.log("migrations: ok");

const db = createDb(pool);

// Гигиена: при старте + каждый час (раньше только при старте — на
// долгоживущем процессе без рестарта media_sources разрасталась бесконечно).
const PURGE_TOKENS_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_SOURCES_INTERVAL_MS = 60 * 60 * 1000;
const RESOLVE_SOURCE_TTL_MS = config.resolveSourceTtlMs;

async function purgeOnce() {
  try {
    const purged = await purgeStaleRefreshTokens(db);
    if (purged > 0) console.log(`auth: purged ${purged} stale refresh tokens`);
  } catch (err) {
    console.warn("auth: purge failed:", String(err).slice(0, 200));
  }
  try {
    const stale = await purgeStaleSources(db, RESOLVE_SOURCE_TTL_MS);
    if (stale > 0) console.log(`resolve: purged ${stale} stale media_sources`);
  } catch (err) {
    console.warn("resolve: purge failed:", String(err).slice(0, 200));
  }
}
await purgeOnce();
const purgeTokensTimer = setInterval(() => void purgeOnce(), PURGE_TOKENS_INTERVAL_MS);
const purgeSourcesTimer = setInterval(() => void purgeOnce(), PURGE_SOURCES_INTERVAL_MS);
purgeTokensTimer.unref();
purgeSourcesTimer.unref();

// Догон дыр каталога: сериалы без серий, длинные сезоны (GAP_FILL=1 в проде).
if (config.gapFill) startGapFiller(db, config);

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

// Очереди ingest + fill: BullMQ поверх Redis. Без Redis — честный 503 из
// noop-очереди: старый memory-fallback молча логировал и возвращал 202,
// задача висела в pending вечно.
let ingestQueue: IngestQueue = noopIngestQueue;
// Очередь наполнения каталога. Своя от транскода: fill идёт минутами и не
// должен задерживать ingest. Без Redis роут выполняет fill синхронно.
let catalogQueue: CatalogFillQueue = noopCatalogFillQueue;

// Ресурсы для graceful shutdown: без явного закрытия держат event loop
// до force-exit.
const redisClients: Redis[] = [];
const bullQueues: Queue[] = [];

if (process.env.REDIS_URL) {
  try {
    // Один коннект на обе очереди: Queue использует только неблокирующие
    // команды и по правилам BullMQ может делить ioredis-инстанс.
    // Dedicated-коннект требуют Worker и QueueEvents (блокирующие
    // команды) — они живут в apps/worker, не здесь.
    const redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    await redis.connect();
    redisClients.push(redis);

    const queue = new Queue("transcode", { connection: redis });
    const fillQueue = new Queue("catalog", { connection: redis });
    bullQueues.push(queue, fillQueue);

    ingestQueue = {
      async enqueueIngest(payload: IngestJobPayload) {
        // maxRetriesPerRequest: null + умерший Redis = queue.add висит
        // вечно. Режем по таймауту и честно отвечаем 503.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            queue.add("ingest", payload, {
              removeOnComplete: 100,
              // Ретраи: транзиентные сбои (сеть, падение ffmpeg) получают второй
              // шанс; failed-джобы не копятся в Redis бесконечно.
              attempts: 3,
              backoff: { type: "exponential", delay: 30_000 },
              removeOnFail: 500,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("enqueue timeout")),
                5_000,
              );
            }),
          ]);
        } catch (err) {
          // Причину — в лог: «почему Redis не ответил» важнее самого 503.
          console.warn("redis: enqueue ingest failed:", String(err).slice(0, 300));
          throw new HttpError(
            503,
            "queue_unavailable",
            "Ingest queue is not responding",
          );
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };

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
    console.log("redis: connected, ingest + catalog-fill queues ready");
  } catch (_err) {
    console.warn("redis: unavailable, running without transcode queue (fill inline)");
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
        clearInterval(purgeTokensTimer);
        clearInterval(purgeSourcesTimer);
        await app.close();
        // BullMQ-очереди и Redis-коннекты раньше не закрывались вовсе:
        // event loop держался до force-exit, коннекты обрывались грязно.
        await Promise.allSettled(bullQueues.map((q) => q.close()));
        await Promise.allSettled(redisClients.map((c) => c.quit()));
        await pool.end();
      } catch (err) {
        // Уже закрыто — выходим без шума, но причину оставляем в логе.
        console.warn("api: shutdown cleanup failed:", String(err).slice(0, 200));
      }
      process.exit(0);
    })();
  });
}
