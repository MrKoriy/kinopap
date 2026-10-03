/**
 * Релизы AniLibria без пары в каталоге: ищем их в TMDb по оригинальному
 * названию (ромадзи) и году.
 *
 * - Найденный TMDb-тайтл уже есть у нас → это дубль, который не сошёлся по
 *   названию («Jujutsu Kaisen» ↔ «Магическая битва») — склеиваем.
 * - Нет → дописываем релизу TMDb-метаданные: рейтинг, трейлер, tmdb_id.
 *
 * Строго: только японская/китайская/корейская анимация (genre 16), год ±1.
 * Сверка — раз в 30 дней на релиз (items.tmdb_matched_at).
 */
import { absorbAnilibriaItem, type Db } from "@zal/db";
import { sql } from "drizzle-orm";
import type { Config } from "../config";
import { hydrateSerialSeasons, tmdbGet, tmdbTrailer } from "./tmdb";

interface SearchRow {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  first_air_date?: string;
  release_date?: string;
  genre_ids?: number[];
  original_language?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
}

const ANIME_LANGS = new Set(["ja", "zh", "ko"]);

/** Лучший кандидат поиска: анимация, азиатский оригинал, год ±1, самый популярный. */
export function pickTmdbAnime(rows: SearchRow[], year: number | null): SearchRow | null {
  const ok = rows.filter((r) => {
    if (!(r.genre_ids ?? []).includes(16)) return false;
    if (r.original_language && !ANIME_LANGS.has(r.original_language)) return false;
    const d = r.first_air_date ?? r.release_date ?? "";
    const y = d.length >= 4 ? Number(d.slice(0, 4)) : null;
    return year == null || y == null || Math.abs(y - year) <= 1;
  });
  ok.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  return ok[0] ?? null;
}

export async function matchAnilibriaViaTmdb(
  db: Db,
  config: Config,
  opts: { limit?: number; dryRun?: boolean; log?: (s: string) => void } = {},
): Promise<{ merged: number; enriched: number }> {
  const res = await db.execute<{ id: number; title: string; original_title: string | null; year: number | null; movie: boolean }>(sql`
    select i.id, i.title, i.original_title, i.year,
      (not exists (select 1 from seasons s where s.item_id = i.id)
        and (select count(*) from media m where m.item_id = i.id) = 1) as movie
    from items i
    where i.external_source = 'anilibria' and i.tmdb_id is null and i.original_title is not null
      and (i.tmdb_matched_at is null or i.tmdb_matched_at < now() - interval '30 days')
    order by i.views desc nulls last, i.id desc
    limit ${opts.limit ?? 40}
  `);
  let merged = 0;
  let enriched = 0;
  for (const r of res.rows as Array<{ id: number; title: string; original_title: string; year: number | null; movie: boolean }>) {
    const kind = r.movie ? "movie" : "tv";
    const yearKey = kind === "tv" ? "first_air_date_year" : "year";
    const q = encodeURIComponent(r.original_title);
    const found = await tmdbGet<{ results?: SearchRow[] }>(
      config,
      `/search/${kind}?query=${q}${r.year ? `&${yearKey}=${r.year}` : ""}`,
    );
    // Без года TMDb находит чаще (у нас год релиза ≠ году премьеры ±1).
    const found2 =
      found?.results?.length || !r.year
        ? found
        : await tmdbGet<{ results?: SearchRow[] }>(config, `/search/${kind}?query=${q}`);
    const hit = pickTmdbAnime(found2?.results ?? [], r.year);
    if (!opts.dryRun) {
      await db.execute(sql`update items set tmdb_matched_at = now() where id = ${r.id}`);
    }
    if (!hit) continue;

    const tmdbType = kind;
    const existing = await db.execute<{ id: number; type: string; external_source: string | null }>(sql`
      select id, type, external_source from items
      where tmdb_id = ${hit.id} and (tmdb_type = ${tmdbType} or tmdb_type is null) and id <> ${r.id}
      limit 1`);
    const twin = (existing.rows as Array<{ id: number; type: string; external_source: string | null }>)[0];
    if (twin && twin.external_source == null) {
      opts.log?.(`  merge #${r.id} «${r.title}» → #${twin.id} (tmdb ${tmdbType}/${hit.id})`);
      if (opts.dryRun) continue;
      try {
        if (twin.type !== "movie") {
          const eps = await db.execute<{ n: number }>(sql`
            select count(*)::int as n from episodes e join seasons s on s.id = e.season_id where s.item_id = ${twin.id}`);
          if (Number((eps.rows as Array<{ n: number }>)[0]?.n ?? 0) === 0) {
            await hydrateSerialSeasons(db, config, twin.id, hit.id).catch(() => false);
          }
        }
        await absorbAnilibriaItem(db, r.id, twin.id);
        merged++;
      } catch (err) {
        console.warn(`anime-tmdb-match: merge #${r.id} → #${twin.id} failed:`, String(err).slice(0, 200));
      }
      continue;
    }
    if (twin) continue; // tmdb_id занят другим релизом — не трогаем
    opts.log?.(`  enrich #${r.id} «${r.title}» ← tmdb ${tmdbType}/${hit.id} ★${hit.vote_average ?? "-"}`);
    if (opts.dryRun) continue;
    const trailer = await tmdbTrailer(config, tmdbType, hit.id).catch(() => null);
    try {
      await db.execute(sql`
        update items set
          tmdb_id = ${hit.id},
          tmdb_type = ${tmdbType},
          tmdb_rating = ${hit.vote_average && hit.vote_count && hit.vote_count >= 10 ? Math.round(hit.vote_average * 10) / 10 : null},
          tmdb_votes = ${hit.vote_count ?? null},
          trailer_id = coalesce(trailer_id, ${trailer?.id ?? null}),
          trailer_url = coalesce(trailer_url, ${trailer?.url ?? null}),
          updated_at = now()
        where id = ${r.id}`);
      enriched++;
    } catch (err) {
      // уникальность (tmdb_type, tmdb_id) — параллельный импорт успел раньше
      console.warn(`anime-tmdb-match: enrich #${r.id} failed:`, String(err).slice(0, 200));
    }
  }
  return { merged, enriched };
}
