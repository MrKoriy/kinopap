/**
 * Расписание «старта видео» в BullMQ: своя очередь `stream`, job schedulers
 * (как у автопилота — переживают рестарт, не дублируются) и воркер с
 * concurrency 1: precheck и прогрев голов не идут параллельно и не душат
 * ни rutor, ни TorrServer. Выключается STREAM_PRECHECK=0.
 */
import type { Db } from "@zal/db";
import { StreamResolver } from "@zal/ingest";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  DEFAULT_PRECHECK,
  type HeadWarmOptions,
  type PrecheckOptions,
  redisMissStore,
  redisRateLimiter,
  runHeadWarm,
  runStreamPrecheck,
} from "./stream-precheck";

export const STREAM_QUEUE = "stream";
const MIN = 60 * 1000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

export interface StreamJobsConfig {
  precheckEveryMs: number;
  headWarmEveryMs: number;
  precheck: PrecheckOptions;
  headWarm: HeadWarmOptions;
  /** Поисков rutor в минуту (общий лимит в Redis). */
  rutorPerMinute: number;
  torrServerUrl: string;
  anilibriaUrl?: string;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Настройки из env; все ручки с безопасными дефолтами. */
export function streamJobsConfig(env: NodeJS.ProcessEnv = process.env): StreamJobsConfig {
  return {
    precheckEveryMs: num(env, "STREAM_PRECHECK_EVERY_MIN", 15) * MIN,
    headWarmEveryMs: num(env, "STREAM_HEAD_WARM_EVERY_MIN", 30) * MIN,
    rutorPerMinute: Math.max(1, num(env, "STREAM_PRECHECK_RUTOR_PER_MIN", 12)),
    precheck: {
      ...DEFAULT_PRECHECK,
      batch: num(env, "STREAM_PRECHECK_BATCH", DEFAULT_PRECHECK.batch),
      topLimit: num(env, "STREAM_PRECHECK_TOP", DEFAULT_PRECHECK.topLimit),
      recheckBatch: num(env, "STREAM_RECHECK_BATCH", DEFAULT_PRECHECK.recheckBatch),
      recheckAfterMs: num(env, "STREAM_RECHECK_HOURS", 72) * 60 * MIN,
      pauseMs: num(env, "STREAM_PRECHECK_PAUSE_MS", DEFAULT_PRECHECK.pauseMs),
    },
    headWarm: {
      top: num(env, "STREAM_HEAD_WARM_TOP", 200),
      headBytes: num(env, "STREAM_HEAD_MB", 64) * MB,
      cacheDir: env.TS_CACHE_DIR || "/opt/kinopap/data/ts-cache",
      maxBytes: num(env, "TS_CACHE_MAX_GB", 25) * GB,
      fillRatio: 0.9,
      pauseMs: num(env, "STREAM_HEAD_WARM_PAUSE_MS", 500),
    },
    torrServerUrl: env.TORRSERVER_URL ?? "http://localhost:8090",
    anilibriaUrl: env.ANILIBRIA_URL,
  };
}

export async function startStreamJobs(
  connection: Redis,
  db: Db,
  cfg: StreamJobsConfig = streamJobsConfig(),
): Promise<() => Promise<void>> {
  const queue = new Queue(STREAM_QUEUE, { connection: connection as ConnectionOptions });
  const jobOpts = { removeOnComplete: 20, removeOnFail: 20 };
  await queue.upsertJobScheduler(
    "stream-precheck",
    { every: cfg.precheckEveryMs },
    { name: "stream-precheck", data: {}, opts: jobOpts },
  );
  if (cfg.headWarm.top > 0) {
    await queue.upsertJobScheduler(
      "stream-headwarm",
      { every: cfg.headWarmEveryMs },
      { name: "stream-headwarm", data: {}, opts: jobOpts },
    );
  } else {
    await queue.removeJobScheduler("stream-headwarm").catch(() => false);
  }

  const resolver = new StreamResolver({
    torrServerBaseUrl: cfg.torrServerUrl,
    anilibriaBaseUrl: cfg.anilibriaUrl,
  });
  const ctx = {
    db,
    resolver,
    limiter: redisRateLimiter(connection, "rl:rutor:precheck", cfg.rutorPerMinute),
    misses: redisMissStore(connection),
    log: (m: string) => console.log(m),
  };

  const worker = new Worker(
    STREAM_QUEUE,
    async (job: Job) => {
      const started = Date.now();
      if (job.name === "stream-precheck") {
        const s = await runStreamPrecheck(ctx, cfg.precheck);
        console.log(
          `stream-precheck: targets=${s.targets} ok=${s.outcomes.ok} direct=${s.outcomes.direct} ` +
            `fail=${s.outcomes.fail} empty=${s.outcomes.empty} skip=${s.outcomes.skip}` +
            `${s.tripped ? " (стоп: rutor)" : ""} in ${Math.round((Date.now() - started) / 1000)}s`,
        );
        return s;
      }
      if (job.name === "stream-headwarm") {
        const s = await runHeadWarm(ctx, cfg.headWarm);
        console.log(
          `stream-headwarm: targets=${s.targets} warmed=${s.warmed}` +
            `${s.diskFull ? " (потолок диска)" : ""} in ${Math.round((Date.now() - started) / 1000)}s`,
        );
        return s;
      }
      return null;
    },
    // Прогон длится минутами: lock продлевается сам, но запас не помешает.
    { connection: connection.duplicate() as ConnectionOptions, concurrency: 1, lockDuration: 5 * MIN },
  );
  worker.on("error", (err) => {
    console.warn("worker: stream worker error (non-fatal):", String(err).slice(0, 300));
  });
  console.log(
    `stream: precheck каждые ${cfg.precheckEveryMs / MIN} мин (батч ${cfg.precheck.batch}, ` +
      `топ ${cfg.precheck.topLimit}), прогрев голов топ-${cfg.headWarm.top} ` +
      `по ${Math.round(cfg.headWarm.headBytes / MB)} МБ, потолок ${Math.round(cfg.headWarm.maxBytes / GB)} ГБ`,
  );

  return async () => {
    await worker.close();
    await queue.close();
  };
}
