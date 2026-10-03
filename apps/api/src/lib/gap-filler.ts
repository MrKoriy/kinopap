/**
 * Фоновый догон дыр каталога в процессе API (там есть TMDb-слой и гидрация).
 *
 * Автопилот воркера заливает новые сериалы без серий (discover TMDb не отдаёт
 * состав) — раньше серии появлялись только когда первый зритель открывал
 * карточку и ждал. Теперь раз в час берём пачку самых популярных сериалов без
 * серий, гидрируем и сразу раскладываем длинные сезоны.
 */
import { absorbAnilibriaItem, type Db, findAnimeSourcePairs } from "@zal/db";
import { sql } from "drizzle-orm";
import type { Config } from "../config";
import { LONG_SEASON, regroupLongSeasons } from "./season-layout";
import { hydrateSerialSeasons } from "./tmdb";

const HOUR = 60 * 60 * 1000;

/**
 * Аниме-дубли «релиз AniLibria ↔ TMDb-сериал» склеиваются в одну карточку.
 * TMDb-сериал без серий сначала гидрируем — иначе серии релиза некуда влить.
 */
export async function mergeAnimeDuplicates(
  db: Db,
  config: Config,
  opts: { limit?: number; dryRun?: boolean; log?: (s: string) => void } = {},
): Promise<number> {
  const pairs = await findAnimeSourcePairs(db, opts.limit ?? 50);
  let merged = 0;
  for (const p of pairs) {
    if (opts.dryRun) {
      opts.log?.(`  ${p.anilibriaId} → ${p.tmdbItemId} «${p.title}» (${p.anilibriaEpisodes} / ${p.tmdbEpisodes})`);
      continue;
    }
    if (p.tmdbEpisodes === 0) {
      const tm = await db.execute<{ tmdb_id: number }>(sql`select tmdb_id from items where id = ${p.tmdbItemId}`);
      const tmdbId = Number((tm.rows as Array<{ tmdb_id: number }>)[0]?.tmdb_id ?? 0);
      if (tmdbId) await hydrateSerialSeasons(db, config, p.tmdbItemId, tmdbId).catch(() => false);
    }
    try {
      const n = await absorbAnilibriaItem(db, p.anilibriaId, p.tmdbItemId);
      merged++;
      opts.log?.(`  #${p.anilibriaId} → #${p.tmdbItemId} «${p.title}»: ${n} серий с AniLibria`);
    } catch (err) {
      console.warn(`anime-merge: #${p.anilibriaId} → #${p.tmdbItemId} failed:`, String(err).slice(0, 200));
    }
  }
  return merged;
}

export async function gapFillOnce(db: Db, config: Config): Promise<{ hydrated: number; regrouped: number; merged: number }> {
  const res = await db.execute<{ id: number; tmdb_id: number }>(sql`
    select i.id, i.tmdb_id from items i
    where i.type = 'serial' and i.tmdb_id is not null
      and not exists (select 1 from seasons s join episodes e on e.season_id = s.id where s.item_id = i.id)
    order by i.views desc nulls last, i.rating desc nulls last, i.id desc
    limit ${config.gapFillBatch}
  `);
  let hydrated = 0;
  for (const r of res.rows as Array<{ id: number; tmdb_id: number }>) {
    if (await hydrateSerialSeasons(db, config, Number(r.id), Number(r.tmdb_id)).catch(() => false)) {
      hydrated++;
    }
  }
  const long = await db.execute<{ item_id: number }>(sql`
    select s.item_id from seasons s join items i on i.id = s.item_id
    where s.number > 0 and i.season_layout is null
      and (select count(*) from episodes e where e.season_id = s.id) > ${LONG_SEASON}
    group by s.item_id
    order by max(i.views) desc nulls last
    limit 40
  `);
  let regrouped = 0;
  for (const r of long.rows as Array<{ item_id: number }>) {
    const out = await regroupLongSeasons(db, config, Number(r.item_id)).catch(() => null);
    if (out?.status === "regrouped") regrouped++;
  }
  const merged = await mergeAnimeDuplicates(db, config, { limit: 30 });
  return { hydrated, regrouped, merged };
}

export function startGapFiller(db: Db, config: Config): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await gapFillOnce(db, config);
      if (out.hydrated || out.regrouped || out.merged) {
        console.log(`gap-fill: hydrated=${out.hydrated} regrouped=${out.regrouped} merged=${out.merged}`);
      }
    } catch (err) {
      console.warn("gap-fill: failed:", String(err).slice(0, 200));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 5 * 60 * 1000);
  const timer = setInterval(() => void tick(), HOUR);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
