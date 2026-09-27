import { createDb, createPool, purgeStaleRefreshTokens, runMigrations } from "@zal/db";
import { TorrServerConnector } from "@zal/ingest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import type { IngestJobPayload, IngestQueue } from "./ingest-queue";

const config = loadConfig();

const pool = createPool(config.databaseUrl);
await runMigrations(pool);
console.log("migrations: ok");

const db = createDb(pool);

// Гигиена: протухшие refresh-токены раньше не удалялись никогда.
{
  const purged = await purgeStaleRefreshTokens(db);
  if (purged > 0) console.log(`auth: purged ${purged} stale refresh tokens`);
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

const app = await buildApp({ db, config, queue: ingestQueue, logger: true });
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
