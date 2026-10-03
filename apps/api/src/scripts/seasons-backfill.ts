/**
 * Разовый догон сезонов по всему каталогу:
 *   1) сериалы без сезонов (заливка TMDb) — гидрация с TMDb;
 *   2) тайтлы с сезоном > LONG_SEASON серий — раскладка по эпизод-группам.
 *
 * Запуск на сервере (из корня релиза, с .env):
 *   set -a; . ./.env; set +a
 *   pnpm --filter @zal/api exec tsx src/scripts/seasons-backfill.ts --regroup --dry
 *   pnpm --filter @zal/api exec tsx src/scripts/seasons-backfill.ts --hydrate --regroup
 *   ... --merge-anime [--dry]  — склеить дубли «релиз AniLibria ↔ TMDb-сериал»
 *   ... --merge-seasons [--dry] — релизы сезонов («… 2») в сезон N TMDb-тайтла
 *   ... --localize [--dry]     — русские/английские названия вместо иероглифов
 * Флаги: --hydrate, --regroup, --merge-anime, --dry (только показать раскладку), --limit=N, --item=ID.
 */
import { createDb, createPool } from "@zal/db";
import { sql } from "drizzle-orm";
import { loadConfig } from "../config";
import { mergeAnimeDuplicates, mergeAnimeSeasons } from "../lib/gap-filler";
import { localizeForeignTitles } from "../lib/localize-titles";
import { LONG_SEASON, regroupLongSeasons } from "../lib/season-layout";
import { hydrateSerialSeasons } from "../lib/tmdb";

const args = new Set(process.argv.slice(2));
const flag = (name: string) => [...args].find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const limit = Number(flag("limit") ?? 100000);
const onlyItem = flag("item") ? Number(flag("item")) : null;
const dryRun = args.has("--dry");

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDb(pool);

async function pMap<T>(list: T[], concurrency: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < list.length) {
        const i = next++;
        await fn(list[i]!, i);
      }
    }),
  );
}

async function hydrateAll() {
  const res = await db.execute<{ id: number; tmdb_id: number }>(sql`
    select i.id, i.tmdb_id from items i
    where i.type = 'serial' and i.tmdb_id is not null
      and not exists (select 1 from seasons s join episodes e on e.season_id = s.id where s.item_id = i.id)
      ${onlyItem ? sql`and i.id = ${onlyItem}` : sql``}
    order by i.views desc nulls last, i.rating desc nulls last
    limit ${limit}
  `);
  const rows = res.rows as Array<{ id: number; tmdb_id: number }>;
  console.log(`hydrate: ${rows.length} сериалов без серий`);
  let ok = 0;
  await pMap(rows, 3, async (r, i) => {
    const done = await hydrateSerialSeasons(db, config, Number(r.id), Number(r.tmdb_id)).catch(() => false);
    if (done) ok++;
    if ((i + 1) % 50 === 0) console.log(`  hydrate ${i + 1}/${rows.length}, с сериями: ${ok}`);
  });
  console.log(`hydrate: готово, с сериями ${ok}/${rows.length}`);
}

async function regroupAll() {
  const res = await db.execute<{ item_id: number; title: string; n: number }>(sql`
    select s.item_id, i.title, max(c.n)::int as n
    from seasons s
    join items i on i.id = s.item_id
    join lateral (select count(*) as n from episodes e where e.season_id = s.id) c on true
    where s.number > 0 and i.season_layout is null
      ${onlyItem ? sql`and i.id = ${onlyItem}` : sql``}
    group by s.item_id, i.title
    having max(c.n) > ${LONG_SEASON}
    order by max(c.n) desc
    limit ${limit}
  `);
  const rows = res.rows as Array<{ item_id: number; title: string; n: number }>;
  console.log(`regroup: ${rows.length} тайтлов с сезоном > ${LONG_SEASON} серий${dryRun ? " (dry run)" : ""}`);
  const stats: Record<string, number> = {};
  await pMap(rows, 2, async (r) => {
    const out = await regroupLongSeasons(db, config, Number(r.item_id), { dryRun }).catch((e) => ({
      status: `error: ${String(e).slice(0, 120)}`,
    }));
    stats[out.status.split(":")[0]!] = (stats[out.status.split(":")[0]!] ?? 0) + 1;
    const extra = "seasons" in out && out.seasons ? ` → ${out.seasons} сез. ${"layout" in out ? out.layout : ""}` : "";
    console.log(`  #${r.item_id} «${r.title}» (${r.n} сер.): ${out.status}${extra}`);
  });
  console.log("regroup: итог", stats);
}

try {
  if (args.has("--hydrate")) await hydrateAll();
  if (args.has("--regroup")) await regroupAll();
  if (args.has("--merge-anime")) {
    const n = await mergeAnimeDuplicates(db, config, { limit, dryRun, log: (l) => console.log(l) });
    console.log(`merge-anime: склеено ${n}${dryRun ? " (dry run)" : ""}`);
  }
  if (args.has("--merge-seasons")) {
    const n = await mergeAnimeSeasons(db, { limit, dryRun, log: (l) => console.log(l) });
    console.log(`merge-seasons: склеено ${n}${dryRun ? " (dry run)" : ""}`);
  }
  if (args.has("--localize")) {
    const n = await localizeForeignTitles(db, config, { limit, dryRun, log: (l) => console.log(l) });
    console.log(`localize: переименовано ${n}${dryRun ? " (dry run)" : ""}`);
  }
} finally {
  await pool.end();
}
