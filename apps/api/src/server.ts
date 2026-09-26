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

// Очередь ingest: BullMQ поверх Redis.
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
const queue = new Queue("transcode", { connection: redis });
const ingestQueue: IngestQueue = {
  async enqueueIngest(payload: IngestJobPayload) {
    await queue.add("ingest", payload, { removeOnComplete: 100 });
  },
};

const app = await buildApp({ db, config, queue: ingestQueue, logger: true });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`api: listening on :${config.port}`);
