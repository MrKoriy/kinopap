/**
 * Автопилот каталога: каталог пополняется сам, без ручных POST /v1/discover.
 *
 * - каждые 6 ч — свежие релизы (текущий и прошлый год) и новые серии AniLibria;
 * - раз в сутки — широкий проход (жанры × страны, подборки) и дедуп;
 * - раз в сутки — догон трейлеров (дочерним процессом, со своим темпом).
 *
 * Расписание — BullMQ job schedulers в той же очереди `catalog`: джобы
 * переживают рестарт воркера, не дублируются (upsert по id) и идут строго
 * по одной (concurrency 1) — ручной fill и автопилот друг другу не мешают.
 * Выключается AUTOPILOT=0.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FillSpec } from "@zal/ingest";
import { type ConnectionOptions, Queue } from "bullmq";
import { CATALOG_QUEUE, type CatalogJobSpec } from "./catalog";

const HOUR = 60 * 60 * 1000;

export interface AutopilotSchedule {
  id: string;
  everyMs: number;
  spec: FillSpec;
}

export function autopilotSchedules(now = new Date()): AutopilotSchedule[] {
  const y = now.getUTCFullYear();
  return [
    {
      id: "autopilot-fresh",
      everyMs: 6 * HOUR,
      spec: { years: [y, y - 1], yearPages: 3, anime: true, animeLimit: 300, dedupe: true },
    },
    {
      id: "autopilot-wide",
      everyMs: 24 * HOUR,
      spec: {
        genreMatrix: true,
        genrePages: 2,
        lists: true,
        countries: ["RU", "US", "KR", "JP", "GB", "FR", "TR", "IN", "CN", "ES"],
        countryPages: 2,
        dedupe: true,
      },
    },
  ];
}

export async function startAutopilot(
  connection: ConnectionOptions,
  opts: { trailers?: boolean; trailersEveryMs?: number } = {},
): Promise<() => Promise<void>> {
  const queue = new Queue<CatalogJobSpec>(CATALOG_QUEUE, { connection });
  for (const s of autopilotSchedules()) {
    await queue.upsertJobScheduler(
      s.id,
      { every: s.everyMs },
      { name: s.id, data: { spec: s.spec }, opts: { removeOnComplete: 20, removeOnFail: 20 } },
    );
  }
  console.log(`autopilot: расписание ${autopilotSchedules().map((s) => s.id).join(", ")}`);

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.trailers !== false) {
    let running = false;
    const runTrailers = () => {
      if (running) return;
      running = true;
      const script = fileURLToPath(new URL("./backfill-trailers.ts", import.meta.url));
      // Тот же tsx-загрузчик, что у самого воркера (execArgv), — без npx.
      const child = spawn(process.execPath, [...process.execArgv, script, "--limit=2000"], {
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      });
      child.on("exit", (code) => {
        running = false;
        console.log(`autopilot: trailers backfill exited with ${code}`);
      });
      child.on("error", () => {
        running = false;
      });
    };
    // Первый прогон через 10 минут после старта — не в момент деплоя.
    setTimeout(runTrailers, 10 * 60 * 1000).unref();
    timer = setInterval(runTrailers, opts.trailersEveryMs ?? 24 * HOUR);
    timer.unref();
  }

  return async () => {
    if (timer) clearInterval(timer);
    await queue.close();
  };
}
