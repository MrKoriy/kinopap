/**
 * Бэкфилл актёров и команды: таблицы people/item_people существовали, но не
 * заполнялись. Идём по каталогу курсором, одним запросом TMDb берём детали +
 * credits (aggregate_credits у сериалов) и бэкдроп, пишем снимок титров.
 *
 * Запуск (нужны DATABASE_URL и TMDB_API_KEY):
 *   pnpm --filter @zal/worker exec tsx src/backfill-credits.ts
 *   pnpm --filter @zal/worker exec tsx src/backfill-credits.ts --limit=500 --dry
 *   pnpm --filter @zal/worker exec tsx src/backfill-credits.ts --concurrency=8 --pace=40
 *
 * Идемпотентен и прерываем: обработанные тайтлы получают credits_checked_at
 * и выпадают из выборки на 60 дней (составы онгоингов дополняются).
 */
import {
  countItemsMissingCredits,
  createDb,
  createPool,
  listItemsMissingCredits,
  markCreditsChecked,
  replaceItemCredits,
} from "@zal/db";
import { creditsToRows, fetchTmdbCredits, TmdbClient, tmdbKindOf } from "@zal/ingest";
import { makePacer, pagedById, parseArgs, runPool } from "./lib/script";

const { flag, num } = parseArgs();
const dryRun = flag("dry");
const maxItems = num("limit", Number.POSITIVE_INFINITY);
const concurrency = Math.floor(num("concurrency", 8));
const pace = makePacer(num("pace", 40));

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.TMDB_API_KEY;
if (!databaseUrl || !apiKey) {
  console.error("DATABASE_URL и TMDB_API_KEY обязательны");
  process.exit(1);
}

const db = createDb(createPool(databaseUrl));
const client = new TmdbClient({ apiKey, timeoutMs: 8000 });

const started = Date.now();
let processed = 0;
let withPeople = 0;
let empty = 0;
let failed = 0;
/** Подряд неудачи: TMDb лежит — не метим тайтлы «проверенными» на 60 дней зря. */
let failStreak = 0;

const total = await countItemsMissingCredits(db);
console.log(`backfill-credits: ${total} тайтлов без титров${dryRun ? " (dry run)" : ""}, воркеров ${concurrency}`);

const source = pagedById((afterId, limit) => listItemsMissingCredits(db, { afterId, limit }), maxItems);

await runPool(source, concurrency, async (row) => {
  try {
    await pace();
    const credits = await fetchTmdbCredits(client, tmdbKindOf(row), row.tmdbId);
    if (!credits) {
      // TMDb не ответил (или 404 у битого id) — помечаем, чтобы не крутить вечно.
      failed += 1;
      failStreak += 1;
      if (!dryRun && failStreak < 20) await markCreditsChecked(db, row.id);
    } else {
      failStreak = 0;
      const rows = creditsToRows(credits);
      if (rows.people.length > 0) withPeople += 1;
      else empty += 1;
      if (!dryRun) await replaceItemCredits(db, row.id, rows.people, { backdropUrl: rows.backdropUrl });
    }
  } catch (err) {
    failed += 1;
    console.warn(`backfill-credits: item ${row.id} (${row.title}) — ${String(err).slice(0, 200)}`);
  }
  processed += 1;
  if (processed % 100 === 0) {
    console.log(`backfill-credits: ${processed}/${total}, с титрами ${withPeople}, пусто ${empty}, ошибок ${failed}`);
  }
});

console.log(
  `backfill-credits: готово. ${processed} обработано, с титрами ${withPeople}, пусто ${empty}, ` +
    `ошибок ${failed}, ${((Date.now() - started) / 1000).toFixed(1)}с`,
);
process.exit(0);
