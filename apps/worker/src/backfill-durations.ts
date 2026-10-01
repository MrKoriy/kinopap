/**
 * Бэкфилл длительности: у тайтлов, попавших в каталог до фикса источников,
 * runtime_avg пуст (discovery его не записывал) или равен сид-фолбэку 7200
 * («2:00:00» у всего топа — сид брал runtime из выдачи поиска TMDb, где его
 * нет). Скрипт в две фазы:
 *
 *   1. SQL по собственным данным: сериалы/аниме — среднее и сумма по эпизодам
 *      (гидрация TMDb и AniLibria пишут реальные минуты), фильмы — среднее по
 *      media-частям, где runtime_avg пуст.
 *   2. TMDb /movie/{id} и /tv/{id} для тайтлов с tmdb_id: у фильма — runtime,
 *      у сериала — episode_run_time[0].
 *
 * Запуск (нужны DATABASE_URL и TMDB_API_KEY):
 *   pnpm --filter @zal/worker exec tsx src/backfill-durations.ts
 *   pnpm --filter @zal/worker exec tsx src/backfill-durations.ts --limit=500
 *   pnpm --filter @zal/worker exec tsx src/backfill-durations.ts --dry
 *   pnpm --filter @zal/worker exec tsx src/backfill-durations.ts --concurrency=8 --pace=40
 *
 * Идемпотентен и прерываем: записанная длительность выпадает из выборки
 * (совпавшая с TMDb 7200 перезапишется тем же значением — это безвредно),
 * повторный запуск продолжает с места остановки по курсору id.
 */

import {
  backfillRuntimeFromLocalData,
  countItemsMissingRuntime,
  createDb,
  createPool,
  listItemsMissingRuntime,
  setItemRuntime,
} from "@zal/db";
import { TmdbClient } from "@zal/ingest";

/** Пауза между СТАРТАМИ запросов, суммарно по всем воркерам. */
const DEFAULT_PACE_MS = 40;
const DEFAULT_CONCURRENCY = 8;
const PAGE_SIZE = 100;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");

function numArg(name: string, fallback: number): number {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const maxItems = numArg("limit", Number.POSITIVE_INFINITY);
const paceMs = numArg("pace", DEFAULT_PACE_MS);
const concurrency = Math.max(1, Math.floor(numArg("concurrency", DEFAULT_CONCURRENCY)));

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.TMDB_API_KEY;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!apiKey) {
  console.error("TMDB_API_KEY is required");
  process.exit(1);
}

const db = createDb(createPool(databaseUrl));
const tmdb = new TmdbClient({ apiKey, requestIntervalMs: paceMs });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Общий ограничитель: следующий запрос стартует не раньше, чем через paceMs
 * после предыдущего. Держит суммарную частоту независимо от числа воркеров.
 */
let nextStart = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextStart);
  nextStart = slot + paceMs;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

/** Минуты TMDb → секунды; null — деталь не нашлась или источник промолчал. */
async function runtimeFromTmdb(
  row: Awaited<ReturnType<typeof listItemsMissingRuntime>>[number],
): Promise<number | null> {
  const kind = row.tmdbType === "tv" ? "tv" : "movie";
  const data = await tmdb.get<{ runtime?: unknown; episode_run_time?: unknown }>(
    `/${kind}/${row.tmdbId}`,
  );
  if (!data) return null;
  const raw =
    kind === "movie"
      ? data.runtime
      : Array.isArray(data.episode_run_time)
        ? data.episode_run_time[0]
        : null;
  return typeof raw === "number" && raw > 0 ? Math.round(raw * 60) : null;
}

type Row = Awaited<ReturnType<typeof listItemsMissingRuntime>>[number];

/**
 * Один асинхронный генератор на всех воркеров: каждый `next()` отдаёт элемент
 * ровно одному потребителю — очередь не нужна и память не растёт.
 */
async function* itemsToProcess(): AsyncGenerator<Row> {
  let afterId = 0;
  let served = 0;
  while (served < maxItems) {
    const batch = await listItemsMissingRuntime(db, {
      limit: Math.min(PAGE_SIZE, maxItems - served),
      afterId,
    });
    if (batch.length === 0) return;
    afterId = batch[batch.length - 1].id;
    served += batch.length;
    for (const row of batch) yield row;
  }
}

/* ---------- Фаза 1: свои данные, без внешних API ---------- */

const local = await backfillRuntimeFromLocalData(db);
console.log(
  `backfill-durations: SQL-фаза — сериалов/аниме ${local.serials}, фильмов ${local.movies}` +
    `${dryRun ? " (dry run)" : ""}`,
);

/* ---------- Фаза 2: детали TMDb ---------- */

const started = Date.now();
let processed = 0;
let found = 0;
let failed = 0;
let missing = 0;

const total = await countItemsMissingRuntime(db);
console.log(
  `backfill-durations: TMDb-фаза — ${total} тайтлов${dryRun ? " (dry run)" : ""}, ` +
    `воркеров ${concurrency}, темп ${paceMs} мс`,
);

const source = itemsToProcess();

async function worker(): Promise<void> {
  for await (const row of source) {
    try {
      await pace();
      const runtimeSeconds = await runtimeFromTmdb(row);
      if (runtimeSeconds != null) {
        found += 1;
        if (!dryRun) await setItemRuntime(db, row.id, runtimeSeconds);
      } else {
        missing += 1;
      }
    } catch (err) {
      failed += 1;
      console.warn(`backfill-durations: item ${row.id} (${row.title}) — ${String(err)}`);
    }
    processed += 1;
    if (processed % 50 === 0) {
      const secs = (Date.now() - started) / 1000;
      console.log(
        `backfill-durations: ${processed}/${total} обработано, найдено ${found}, ` +
          `без длительности ${missing}, ошибок ${failed}, ${(secs / processed * 1000).toFixed(0)} мс/тайтл`,
      );
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const perItem = processed > 0 ? ((Date.now() - started) / processed).toFixed(0) : "-";
console.log(
  `backfill-durations: готово. Обработано ${processed}, найдено ${found}, ` +
    `без длительности ${missing}, ошибок ${failed}, ${seconds}с, ${perItem} мс/тайтл`,
);
process.exit(0);
