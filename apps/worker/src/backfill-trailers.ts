/**
 * Бэкфилл трейлеров: у тайтлов, попавших в каталог до подключения TMDb
 * /videos, колонки trailer_id/trailer_url пустые. Скрипт идёт по каталогу
 * курсором, дёргает TMDb и записывает найденное.
 *
 * Запуск (нужны DATABASE_URL и TMDB_API_KEY):
 *   pnpm --filter @zal/worker exec tsx src/backfill-trailers.ts
 *   pnpm --filter @zal/worker exec tsx src/backfill-trailers.ts --limit=500
 *   pnpm --filter @zal/worker exec tsx src/backfill-trailers.ts --dry
 *
 * Скрипт идемпотентен и прерываем: записанные трейлеры выпадают из выборки,
 * повторный запуск продолжает с того же места.
 */

import { countItemsMissingTrailer, createDb, createPool, listItemsMissingTrailer, setItemTrailer } from "@zal/db";
import { TmdbEnricher } from "@zal/ingest";

/** TMDb держит ~40 rps; 60 мс — с запасом и без 429. */
const PACE_MS = 60;
const PAGE_SIZE = 100;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
const limitArg = args.find((a) => a.startsWith("--limit="));
const maxItems = limitArg ? Number(limitArg.split("=")[1]) : Number.POSITIVE_INFINITY;

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

const started = Date.now();
let processed = 0;
let found = 0;
let failed = 0;
let afterId = 0;

const total = await countItemsMissingTrailer(db);
console.log(
  `backfill-trailers: ${total} тайтлов без трейлера${dryRun ? " (dry run)" : ""}`,
);

while (processed < maxItems) {
  const batch = await listItemsMissingTrailer(db, {
    limit: Math.min(PAGE_SIZE, maxItems - processed),
    afterId,
  });
  if (batch.length === 0) break;

  for (const row of batch) {
    afterId = row.id;
    processed += 1;
    try {
      const trailer = await enricher.trailer({ type: row.type, tmdbId: row.tmdbId });
      if (trailer) {
        found += 1;
        if (!dryRun) {
          await setItemTrailer(db, row.id, trailer);
        }
      }
      if (processed % 50 === 0) {
        console.log(
          `backfill-trailers: ${processed}/${total} обработано, найдено ${found}, ошибок ${failed}`,
        );
      }
    } catch (err) {
      failed += 1;
      console.warn(`backfill-trailers: item ${row.id} (${row.title}) — ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `backfill-trailers: готово. Обработано ${processed}, найдено ${found}, ошибок ${failed}, ${seconds}с`,
);
process.exit(0);
