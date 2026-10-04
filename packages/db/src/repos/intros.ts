/**
 * Очередь детектора заставок: сезоны популярных сериалов, у серий которых
 * уже есть прогретый торрент (media_sources.warm), и запись найденного.
 */
import type { WarmRelease } from "@zal/api-client";
import { sql } from "drizzle-orm";
import type { Db } from "../db";

export interface IntroSeasonRow {
  seasonId: number;
  itemId: number;
  title: string;
  seasonNumber: number;
}

export interface IntroEpisodeRow {
  mediaId: number;
  episodeNumber: number;
  checked: boolean;
  warm: WarmRelease | null;
  /** Прямая http-ссылка из кэша резолва — запасной вариант без warm. */
  httpUrl: string | null;
}

/**
 * Сезоны, где ≥2 серий с источником ещё не проверены детектором.
 * Аниме AniLibria пропускаем — у них интро приходит из релиза.
 */
export async function listSeasonsForIntroDetect(db: Db, limit: number): Promise<IntroSeasonRow[]> {
  const res = await db.execute(sql`
    select s.id as "seasonId", i.id as "itemId", i.title, s.number as "seasonNumber"
    from seasons s
    join items i on i.id = s.item_id
    join episodes e on e.season_id = s.id
    join media m on m.episode_id = e.id
    join media_sources ms on ms.media_id = m.id and ms.item_id = i.id
    where s.number > 0
      and coalesce(i.external_source, '') <> 'anilibria'
      and m.intro_checked_at is null
      and m.intro_start_seconds is null
      and jsonb_array_length(ms.files) > 0
    group by s.id, i.id, i.title, i.views, s.number
    having count(distinct m.id) >= 2
    order by i.views desc, s.number
    limit ${limit}
  `);
  return res.rows as unknown as IntroSeasonRow[];
}

/** Серии сезона с источником, по порядку. */
export async function listSeasonIntroEpisodes(db: Db, seasonId: number): Promise<IntroEpisodeRow[]> {
  const res = await db.execute(sql`
    select distinct on (e.number)
      m.id as "mediaId", e.number as "episodeNumber",
      (m.intro_checked_at is not null) as checked,
      ms.warm, ms.files -> 0 -> 'urls' ->> 'http' as "httpUrl"
    from episodes e
    join media m on m.episode_id = e.id
    join media_sources ms on ms.media_id = m.id
    where e.season_id = ${seasonId}
      and jsonb_array_length(ms.files) > 0
    order by e.number, m.part_number
  `);
  return res.rows as unknown as IntroEpisodeRow[];
}

/**
 * Итог детектора для серии. Уже известное интро (из релиза AniLibria) не трогаем;
 * null — заставку не нашли, только отмечаем проверку.
 */
export async function saveDetectedIntro(
  db: Db,
  mediaId: number,
  intro: { start: number; end: number } | null,
): Promise<void> {
  if (intro) {
    await db.execute(sql`
      update media set
        intro_start_seconds = ${Math.round(intro.start)},
        intro_end_seconds = ${Math.round(intro.end)},
        intro_source = 'audio',
        intro_checked_at = now()
      where id = ${mediaId} and (intro_start_seconds is null or intro_source = 'audio')
    `);
  }
  await db.execute(sql`update media set intro_checked_at = now() where id = ${mediaId}`);
}
