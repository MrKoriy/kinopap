import { Redis } from "ioredis";
import { createDb, createPool } from "@zal/db";
import { makeWorkerDeps } from "./deps";
import { createTranscoderWorker } from "./worker";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(createPool(databaseUrl));
const deps = makeWorkerDeps({
  db,
  mediaRoot: process.env.MEDIA_ROOT ?? "./media",
  mediaBaseUrl: process.env.MEDIA_BASE_URL ?? "http://localhost:9000/zal-media",
  localSourceRoot: process.env.LOCAL_SOURCE_ROOT ?? "./sources",
  tmdbApiKey: process.env.TMDB_API_KEY,
  ffmpeg: {
    preset: process.env.FFMPEG_PRESET ?? "veryfast",
    crf: process.env.FFMPEG_CRF ? Number(process.env.FFMPEG_CRF) : 23,
    hlsTime: process.env.FFMPEG_HLS_TIME ? Number(process.env.FFMPEG_HLS_TIME) : 4,
  },
});

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const worker = createTranscoderWorker(connection, deps);
console.log("worker: started, waiting for ingest/transcode jobs");

async function shutdown(signal: string): Promise<void> {
  console.log(`worker: ${signal}, closing`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
