/**
 * Автопилот каталога: каталог пополняется сам, без ручных POST /v1/discover.
 *
 * - каждые 6 ч — свежие релизы (текущий и прошлый год) и новые серии AniLibria;
 * - раз в сутки — широкий проход (жанры × страны, подборки) и дедуп;
 * - раз в сутки — ночные задачи (дочерними процессами, по очереди, со своим
 *   темпом): трейлеры, титры, франшизы, картинки, quality-audit, заставки.
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

export interface NightlyTask {
  script: string;
  args: string[];
}

/**
 * Суточный цикл фоновых задач (по порядку): трейлеры, титры, франшизы
 * AniList, картинки, аудит качества, детекция заставок. Отключение одной —
 * env NIGHTLY_SKIP=credits,intros (по имени скрипта без расширения).
 */
export function nightlyTasks(env: NodeJS.ProcessEnv = process.env): NightlyTask[] {
  const skip = new Set((env.NIGHTLY_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const all: NightlyTask[] = [
    { script: "backfill-trailers.ts", args: ["--limit=2000"] },
    { script: "backfill-credits.ts", args: ["--limit=4000"] },
    { script: "franchises.ts", args: ["--limit=300"] },
    { script: "images.ts", args: ["--limit=3000"] },
    { script: "quality-audit.ts", args: [] },
    { script: "intros.ts", args: ["--limit=40"] },
  ];
  return all.filter((t) => !skip.has(t.script.replace(/\.ts$/, "").replace(/^backfill-/, "")) && !skip.has(t.script.replace(/\.ts$/, "")));
}

/** Скрипт воркера дочерним процессом тем же tsx-загрузчиком (execArgv), без npx. */
function runScript(script: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const path = fileURLToPath(new URL(`./${script}`, import.meta.url));
    const child = spawn(process.execPath, [...process.execArgv, path, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
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
    // Ночные задачи — дочерними процессами строго по очереди: у каждой свой
    // темп к внешним API, а вместе они не душат БД и TMDb.
    const runNightly = async () => {
      if (running) return;
      running = true;
      try {
        for (const task of nightlyTasks()) {
          const code = await runScript(task.script, task.args);
          console.log(`autopilot: ${task.script} exited with ${code}`);
        }
      } finally {
        running = false;
      }
    };
    // Первый прогон через 10 минут после старта — не в момент деплоя.
    setTimeout(() => void runNightly(), 10 * 60 * 1000).unref();
    timer = setInterval(() => void runNightly(), opts.trailersEveryMs ?? 24 * HOUR);
    timer.unref();
  }

  return async () => {
    if (timer) clearInterval(timer);
    await queue.close();
  };
}
