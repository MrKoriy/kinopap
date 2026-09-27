import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createDb, createPool, runMigrations } from "@zal/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import type { IngestJobPayload, IngestQueue } from "./ingest-queue";

const config = loadConfig();

const pool = createPool(config.databaseUrl);
await runMigrations(pool);
console.log("migrations: ok");

const db = createDb(pool);

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
        await queue.add("ingest", payload, { removeOnComplete: 100 });
      },
    };
    console.log("redis: connected, queue ready");
  } catch (err) {
    console.warn("redis: unavailable, running without transcode queue");
  }
}

const app = await buildApp({ db, config, queue: ingestQueue, logger: true });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`api: listening on :${config.port}`);
