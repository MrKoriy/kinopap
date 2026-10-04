import type { SearchCache } from "@zal/ingest";
import type { Redis } from "ioredis";

/** Потолок ожидания Redis: кэш — ускорение, а не зависимость запроса. */
const REDIS_CACHE_TIMEOUT_MS = 300;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("redis cache timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * KV-кэш для StreamResolver/RutorConnector поверх ioredis. Коннект API
 * создан с maxRetriesPerRequest: null (так требует BullMQ), поэтому при
 * лежащем Redis команда висела бы вечно — режем по таймауту, и поиск идёт
 * на трекер напрямую.
 */
export function redisSearchCache(redis: Redis): SearchCache {
  return {
    get: (key) => withTimeout(redis.get(key), REDIS_CACHE_TIMEOUT_MS),
    set: async (key, value, ttlSeconds) => {
      await withTimeout(redis.set(key, value, "EX", ttlSeconds), REDIS_CACHE_TIMEOUT_MS);
    },
  };
}
