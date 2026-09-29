/**
 * Бэкфилл трейлеров: у тайтлов, попавших в каталог до подключения TMDb
 * /videos, колонки trailer_id/trailer_url пустые. Скрипт идёт по каталогу
 * курсором, дёргает TMDb и записывает найденное.
 *
 * Запуск (нужны DATABASE_URL и TMDB_API_KEY):
 *   pnpm --filter @zal/worker exec tsx src/backfill-trailers.ts
 *   pnpm --filter @zal/worker exec tsx src/backfill-trailers.ts --limit=500
 *   pnpm --filter @zal/worker exec tsx src/backfill-trailers.ts --dry
 *   pnpm --filter @zal/worker exec tsx src/backfill-trailers.ts --concurrency=8 --pace=40
 *
 * Скрипт идемпотентен и прерываем: записанные трейлеры выпадают из выборки,
 * повторный запуск продолжает с того же места. Тайтлы, у которых трейлера нет
 * на самом TMDb, помечаются trailer_checked_at и выпадают из выборки на 90
 * дней — раньше они оставались в ней навсегда и каждый прогон переспрашивал
 * TMDb о них же (полный прогон рос вместе с «безтрейлерным» хвостом).
 *
 * Почему пул воркеров, а не последовательный цикл: 260 мс на тайтл — это почти
 * целиком ожидание ответа TMDb, а не работа. Последовательный цикл простаивает
 * 95% времени, и на 23 тыс. тайтлов это ~100 минут. Ограничитель темпа при
 * этом общий на все воркеры, а не по таймеру в каждом: иначе N воркеров дали бы
 * N× частоту запросов и TMDb ответил бы 429.
 */

import {
  countItemsMissingTrailer,
  createDb,
  createPool,
  listItemsMissingTrailer,
  markTrailerChecked,
  setItemTrailer,
} from "@zal/db";
import { TmdbEnricher } from "@zal/ingest";

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
const enricher = new TmdbEnricher({ apiKey });

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

type Row = Awaited<ReturnType<typeof listItemsMissingTrailer>>[number];

/**
 * Один асинхронный генератор на всех воркеров: каждый `next()` отдаёт элемент
 * ровно одному потребителю, поэтому очередь не нужна и память не растёт.
 *
 * Генератор создаётся ОДИН раз и передаётся воркерам. Если создавать его внутри
 * воркера, каждый воркер получит свой курсор с нуля и все начнут с одних и тех
 * же первых строк — при восьми воркерах это восьмикратная дублирующая работа.
 */
async function* itemsToProcess(): AsyncGenerator<Row> {
  let afterId = 0;
  let served = 0;
  while (served < maxItems) {
    const batch = await listItemsMissingTrailer(db, {
      limit: Math.min(PAGE_SIZE, maxItems - served),
      afterId,
    });
    if (batch.length === 0) return;
    afterId = batch[batch.length - 1].id;
    served += batch.length;
    for (const row of batch) yield row;
  }
}

const started = Date.now();
let processed = 0;
let found = 0;
let failed = 0;
let noTrailer = 0;

const total = await countItemsMissingTrailer(db);
console.log(
  `backfill-trailers: ${total} тайтлов без трейлера${dryRun ? " (dry run)" : ""}, ` +
    `воркеров ${concurrency}, темп ${paceMs} мс`,
);

const source = itemsToProcess();

async function worker(): Promise<void> {
  for await (const row of source) {
    try {
      await pace();
      const trailer = await enricher.trailer({ type: row.type, tmdbId: row.tmdbId });
      if (trailer) {
        found += 1;
        if (!dryRun) await setItemTrailer(db, row.id, trailer);
      } else {
        // Негативный кэш: TMDb подтвердил отсутствие — не спрашивать 90 дней.
        noTrailer += 1;
        if (!dryRun) await markTrailerChecked(db, row.id);
      }
    } catch (err) {
      failed += 1;
      console.warn(`backfill-trailers: item ${row.id} (${row.title}) — ${String(err)}`);
    }
    processed += 1;
    if (processed % 50 === 0) {
      const secs = (Date.now() - started) / 1000;
      console.log(
        `backfill-trailers: ${processed}/${total} обработано, найдено ${found}, ` +
          `без трейлера ${noTrailer}, ошибок ${failed}, ${(secs / processed * 1000).toFixed(0)} мс/тайтл`,
      );
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const perItem = processed > 0 ? ((Date.now() - started) / processed).toFixed(0) : "-";
console.log(
  `backfill-trailers: готово. Обработано ${processed}, найдено ${found}, ` +
    `без трейлера ${noTrailer}, ошибок ${failed}, ${seconds}с, ${perItem} мс/тайтл`,
);
process.exit(0);
