import { Redis } from "ioredis";
import { createTranscoderWorker } from "./worker";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const worker = createTranscoderWorker(connection);
console.log("worker: started, waiting for transcode jobs");

async function shutdown(signal: string): Promise<void> {
  console.log(`worker: ${signal}, closing`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
