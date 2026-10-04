/**
 * Склейка аниме-дублей между источниками: релиз AniLibria («Дандадан»,
 * type=anime) и тот же тайтл из TMDb (type=serial). В каталоге и «Похожем»
 * это две карточки одного аниме.
 *
 * Выживает TMDb-тайтл (полные сезоны, рейтинги, трейлер, постер без
 * водяного знака). AniLibria-серии вливаются в его серии по сквозному
 * номеру: k-я серия релиза → k-я серия TMDb по порядку просмотра. У серии
 * остаётся ОДНА media — плейсхолдер TMDb получает source_key AniLibria
 * («anilibria:<release>:<ordinal>»), по нему резолвер берёт мгновенный HLS
 * AniLibria для этой серии, а для остальных — торренты как раньше.
 *
 * Внешний id релиза переезжает на выжившего: повторный импорт AniLibria
 * находит его же (а не создаёт карточку заново) и дописывает новые серии.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { recordExternalAlias } from "./aliases";
import { recordItemRedirect } from "./redirects";
import { flatEpisodes } from "./seasons";

export interface AnimePair {
  anilibriaId: number;
  tmdbItemId: number;
  title: string;
  anilibriaEpisodes: number;
  tmdbEpisodes: number;
}

/** Пары «релиз AniLibria ↔ TMDb-тайтл»: одно название (рус. или ориг.), год ±1. */
export async function findAnimeSourcePairs(db: Db, limit = 1000): Promise<AnimePair[]> {
  const res = await db.execute<{
    aid: number;
    tid: number;
    title: string;
    am: number;
    te: number;
  }>(sql`
    with a as (
      select id, title, year,
        regexp_replace(lower(title), '[^[:alnum:]]+', '', 'g') as nt,
        regexp_replace(lower(original_title), '[^[:alnum:]]+', '', 'g') as no
      from items where external_source = 'anilibria'
    ),
    t as (
      select id, title, year,
        regexp_replace(lower(title), '[^[:alnum:]]+', '', 'g') as nt,
        regexp_replace(lower(original_title), '[^[:alnum:]]+', '', 'g') as no
      from items
      where external_source is null and tmdb_id is not null and type in ('serial', 'anime', 'movie')
    ),
    p as (
      select distinct on (a.id) a.id as aid, t.id as tid, a.title
      from a join t
        -- сравнение без регистра и пунктуации: «Магическая битва 0. Фильм» =
        -- «Магическая битва 0 Фильм», «—» = «–», хвостовой «♀»
        -- (пустая нормализация — только точное совпадение, без «'' = ''»)
        on ((a.nt <> '' and a.nt = t.nt) or (a.no <> '' and a.no = t.no) or lower(a.title) = lower(t.title))
       and coalesce(abs(a.year - t.year), 0) <= 1
      order by a.id, (a.nt = t.nt) desc, t.id
    )
    select p.aid, p.tid, p.title,
      (select count(*) from media m where m.item_id = p.aid)::int as am,
      (select count(*) from episodes e join seasons s on s.id = e.season_id
        where s.item_id = p.tid and s.number > 0)::int as te
    from p
    join items ti on ti.id = p.tid
    -- один TMDb-тайтл принимает один релиз (у него одна пара external_*)
    where p.tid in (select tid from p group by tid having count(*) = 1)
      -- фильм TMDb принимает только фильм-релиз: одна media, без сезонов
      and (ti.type <> 'movie' or (
        (select count(*) from media m where m.item_id = p.aid) = 1
        and not exists (select 1 from seasons s where s.item_id = p.aid)))
    limit ${limit}
  `);
  return (res.rows as Array<{ aid: number; tid: number; title: string; am: number; te: number }>).map(
    (r) => ({
      anilibriaId: Number(r.aid),
      tmdbItemId: Number(r.tid),
      title: String(r.title),
      anilibriaEpisodes: Number(r.am),
      tmdbEpisodes: Number(r.te),
    }),
  );
}

/**
 * Вливает релиз AniLibria в TMDb-тайтл. Серии релиза, которым не нашлось
 * пары у TMDb (релиз длиннее), дописываются в последний сезон. Возвращает
 * число серий, получивших AniLibria-источник.
 */
export async function absorbAnilibriaItem(
  db: Db,
  anilibriaId: number,
  targetId: number,
): Promise<number> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const src = await tx.execute<{ external_id: string; plot: string | null }>(sql`
      select external_id, plot from items where id = ${anilibriaId} and external_source = 'anilibria'
    `);
    const release = (src.rows as Array<{ external_id: string; plot: string | null }>)[0];
    if (!release) return 0;

    const kind = await tx.execute<{ type: string }>(sql`select type from items where id = ${targetId}`);
    const targetIsMovie = (kind.rows as Array<{ type: string }>)[0]?.type === "movie";
    if (targetIsMovie) {
      const moved = await absorbMovieMedia(tx, anilibriaId, targetId);
      await moveSocialAndDelete(tx, anilibriaId, targetId, release, "movie");
      return moved;
    }

    const target = await flatEpisodes(tx, targetId);
    // Сквозная нумерация выжившего — по ней же импорт найдёт серию k релиза.
    if (target.length > 0) {
      await tx.execute(sql`
        update episodes e set absolute_number = t.ord::int
        from unnest(${sql.raw(`ARRAY[${target.map((e) => e.id).join(",")}]::int[]`)}) with ordinality as t(id, ord)
        where e.id = t.id and e.absolute_number is null
      `);
    }

    const srcMedia = await tx.execute<{ id: number; source_key: string | null; ordinal: number | null }>(sql`
      select m.id, m.source_key,
        coalesce(e.orig_number, e.number, m.part_number) as ordinal
      from media m left join episodes e on e.id = m.episode_id
      where m.item_id = ${anilibriaId}
      order by ordinal
    `);
    let lastSeasonId = target.at(-1)?.seasonId ?? null;
    let moved = 0;
    for (const m of srcMedia.rows as Array<{ id: number; source_key: string | null; ordinal: number | null }>) {
      const k = Number(m.ordinal ?? 0);
      if (k <= 0) continue;
      let epId: number | null = target[k - 1]?.id ?? null;
      if (epId == null) {
        // Релиз длиннее TMDb (онгоинг убежал вперёд) — серия в конец.
        if (lastSeasonId == null) {
          const s = await tx.execute<{ id: number }>(sql`
            insert into seasons (item_id, number) values (${targetId}, 1)
            on conflict (item_id, number) do update set number = excluded.number
            returning id
          `);
          lastSeasonId = Number((s.rows as Array<{ id: number }>)[0]!.id);
        }
        const meta = await tx.execute<{ title: string | null; runtime: number | null }>(sql`
          select e.title, e.runtime from media m left join episodes e on e.id = m.episode_id where m.id = ${m.id}
        `);
        const info = (meta.rows as Array<{ title: string | null; runtime: number | null }>)[0];
        const e = await tx.execute<{ id: number }>(sql`
          insert into episodes (season_id, number, title, runtime, absolute_number)
          values (${lastSeasonId},
            (select coalesce(max(number), 0) + 1 from episodes where season_id = ${lastSeasonId}),
            ${info?.title ?? null}, ${Number(info?.runtime ?? 0)}, ${k})
          returning id
        `);
        epId = Number((e.rows as Array<{ id: number }>)[0]!.id);
      }

      await adoptIntoEpisode(tx, m.id, targetId, epId);
      moved++;
    }

    await moveSocialAndDelete(tx, anilibriaId, targetId, release, "anime");
    return moved;
  });
}

/** Фильм-релиз AniLibria → плейсхолдер фильма TMDb (одна media без серии). */
async function absorbMovieMedia(tx: Db, anilibriaId: number, targetId: number): Promise<number> {
  const src = await tx.execute<{ id: number }>(sql`select id from media where item_id = ${anilibriaId} order by id limit 1`);
  const m = (src.rows as Array<{ id: number }>)[0];
  if (!m) return 0;
  const ph = await tx.execute<{ id: number }>(sql`
    select id from media where item_id = ${targetId} and episode_id is null
    order by (source_key is null) desc, part_number nulls last, id limit 1
  `);
  const tm = (ph.rows as Array<{ id: number }>)[0];
  if (!tm) {
    await tx.execute(sql`update media set item_id = ${targetId} where id = ${m.id}`);
    await tx.execute(sql`update watch_progress set item_id = ${targetId} where media_id = ${m.id}`);
    return 1;
  }
  await tx.execute(sql`
    update media t set
      source_key = s.source_key,
      runtime = case when t.runtime > 0 then t.runtime else s.runtime end
    from media s where t.id = ${tm.id} and s.id = ${m.id}
  `);
  await tx.execute(sql`
    delete from watch_progress w where w.media_id = ${m.id}
      and exists (select 1 from watch_progress x where x.media_id = ${tm.id} and x.profile_id = w.profile_id)
  `);
  await tx.execute(sql`update watch_progress set media_id = ${tm.id}, item_id = ${targetId} where media_id = ${m.id}`);
  await tx.execute(sql`delete from media where id = ${m.id}`);
  return 1;
}

async function moveSocialAndDelete(
  tx: Db,
  anilibriaId: number,
  targetId: number,
  release: { external_id: string; plot: string | null },
  type: "anime" | "movie" | "season",
): Promise<void> {
    // Социалка и метаданные — как в общем дедупе.
    await tx.execute(sql`
      insert into item_genres (item_id, genre_id)
      select ${targetId}, genre_id from item_genres where item_id = ${anilibriaId}
      on conflict do nothing`);
    await tx.execute(sql`
      insert into favorites (profile_id, item_id)
      select profile_id, ${targetId} from favorites where item_id = ${anilibriaId}
      on conflict do nothing`);
    await tx.execute(sql`
      insert into subscriptions (profile_id, item_id)
      select profile_id, ${targetId} from subscriptions where item_id = ${anilibriaId}
      on conflict do nothing`);
    await tx.execute(sql`
      update votes v set item_id = ${targetId} where v.item_id = ${anilibriaId}
        and not exists (select 1 from votes x where x.profile_id = v.profile_id and x.item_id = ${targetId})`);
    await tx.execute(sql`
      update list_items li set item_id = ${targetId} where li.item_id = ${anilibriaId}
        and not exists (select 1 from list_items x where x.list_id = li.list_id and x.item_id = ${targetId})`);
    await tx.execute(sql`update comments set item_id = ${targetId} where item_id = ${anilibriaId}`);
    await tx.execute(sql`update watch_progress set item_id = ${targetId} where item_id = ${anilibriaId}`);
    await tx.execute(sql`delete from media_sources where item_id in (${anilibriaId}, ${targetId})`);

    await tx.execute(sql`
      update items set external_source = null, external_id = null where id = ${anilibriaId}`);
    if (type === "season") {
      // Релиз сезона: external_* выжившего остаются за релизом первого сезона,
      // этот релиз находится по item_external_aliases.
      await tx.execute(sql`
        update items t set
          views = t.views + (select coalesce(views, 0) from items where id = ${anilibriaId}),
          updated_at = now()
        where t.id = ${targetId}`);
    } else {
    await tx.execute(sql`
      update items t set
        type = ${type},
        external_source = 'anilibria',
        external_id = ${release.external_id},
        plot = coalesce(t.plot, ${release.plot}),
        views = t.views + (select coalesce(views, 0) from items where id = ${anilibriaId}),
        updated_at = now()
      where t.id = ${targetId}`);
    }
    await recordItemRedirect(tx, anilibriaId, targetId);
    await tx.execute(sql`delete from items where id = ${anilibriaId}`);
}

/** media релиза → серия выжившего: плейсхолдер получает source_key, иначе media переезжает. */
async function adoptIntoEpisode(tx: Db, mId: number, targetId: number, epId: number): Promise<void> {
  const m = { id: mId };
  const placeholder = await tx.execute<{ id: number }>(sql`
    select id from media where item_id = ${targetId} and episode_id = ${epId}
    order by (source_key is null) desc, id limit 1
  `);
  const tm = (placeholder.rows as Array<{ id: number }>)[0];
  if (tm) {
    // Одна media на серию: плейсхолдер TMDb получает источник AniLibria.
    await tx.execute(sql`
      update media t set
        source_key = s.source_key,
        intro_start_seconds = coalesce(t.intro_start_seconds, s.intro_start_seconds),
        intro_end_seconds = coalesce(t.intro_end_seconds, s.intro_end_seconds),
        runtime = case when t.runtime > 0 then t.runtime else s.runtime end
      from media s
      where t.id = ${tm.id} and s.id = ${m.id}
    `);
    await tx.execute(sql`
      delete from watch_progress w where w.media_id = ${m.id}
        and exists (select 1 from watch_progress x where x.media_id = ${tm.id} and x.profile_id = w.profile_id)
    `);
    await tx.execute(sql`
      update watch_progress set media_id = ${tm.id}, item_id = ${targetId} where media_id = ${m.id}
    `);
    await tx.execute(sql`delete from media where id = ${m.id}`);
  } else {
    await tx.execute(sql`
      update media set item_id = ${targetId}, episode_id = ${epId} where id = ${m.id}
    `);
    await tx.execute(sql`update watch_progress set item_id = ${targetId} where media_id = ${m.id}`);
  }
}

export interface AnimeSeasonPair {
  anilibriaId: number;
  tmdbItemId: number;
  seasonNumber: number;
  title: string;
  anilibriaEpisodes: number;
  seasonEpisodes: number;
}

const ORDINAL_SEASON = /^(.*?)[\s:.-]*(?:\(?(\d{1,2})(?:st|nd|rd|th)\s+season\)?|season\s+(\d{1,2}))$/i;
const TRAILING_NUM = /^(.*\D)\s+(\d{1,2})$/;
const SEASON_WORD: Record<string, number> = { ni: 2, san: 3, yon: 4 };

/**
 * Номер сезона из названия релиза: «Синий оркестр 2», «Ao no Orchestra 2nd
 * Season», «Spy x Family Season 3». «Часть 2», «Финал», «(2024)» — не сезоны.
 */
export function parseReleaseSeason(title: string | null | undefined): { base: string; season: number } | null {
  const t = (title ?? "").trim();
  if (!t || /част[ьи]|part\s*\d|cour/i.test(t)) return null;
  const o = ORDINAL_SEASON.exec(t);
  if (o) {
    const n = Number(o[2] ?? o[3]);
    return n >= 2 && n <= 20 && o[1]!.trim() ? { base: o[1]!.trim(), season: n } : null;
  }
  const m = TRAILING_NUM.exec(t);
  if (m) {
    const n = Number(m[2]);
    // «Ранма 1/2 (2024) 2» — после скобки года не сезон; «Евангелион 3.0» — не сезон.
    if (n >= 2 && n <= 20 && !/[(/.]\s*$/.test(m[1]!) && !/\)\s*$/.test(m[1]!)) return { base: m[1]!.trim(), season: n };
  }
  const w = /^(.*\S)\s+(ni|san|yon)$/i.exec(t);
  if (w) return { base: w[1]!, season: SEASON_WORD[w[2]!.toLowerCase()]! };
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Пары «релиз сезона AniLibria ↔ сезон N TMDb-тайтла». Тайтл — без
 * перестройки сезонов (иначе номер N уже не сезон источника), в сезоне N
 * есть серии и ни одна ещё не взята из AniLibria.
 */
export async function findAnimeSeasonPairs(db: Db, limit = 200): Promise<AnimeSeasonPair[]> {
  const rel = await db.execute<{ id: number; title: string; original_title: string | null; year: number | null; am: number }>(sql`
    select i.id, i.title, i.original_title, i.year,
      (select count(*) from media m where m.item_id = i.id)::int as am
    from items i where i.external_source = 'anilibria' and i.tmdb_id is null
  `);
  const tm = await db.execute<{ id: number; title: string; original_title: string | null; year: number | null }>(sql`
    select id, title, original_title, year from items
    where tmdb_id is not null and type in ('serial', 'anime')
      and (season_layout is null or season_layout in ('source', 'flat'))
  `);
  const byTitle = new Map<string, Array<{ id: number; year: number | null }>>();
  for (const t of tm.rows as Array<{ id: number; title: string; original_title: string | null; year: number | null }>) {
    for (const k of new Set([norm(t.title), t.original_title ? norm(t.original_title) : ""])) {
      if (!k) continue;
      const list = byTitle.get(k) ?? [];
      list.push({ id: Number(t.id), year: t.year });
      byTitle.set(k, list);
    }
  }
  const cand: AnimeSeasonPair[] = [];
  for (const r of rel.rows as Array<{ id: number; title: string; original_title: string | null; year: number | null; am: number }>) {
    const p = parseReleaseSeason(r.title) ?? parseReleaseSeason(r.original_title);
    if (!p) continue;
    const keys = [norm(p.base)];
    const po = parseReleaseSeason(r.original_title);
    if (po) keys.push(norm(po.base));
    const hits = new Map<number, number | null>();
    for (const k of keys) for (const h of byTitle.get(k) ?? []) hits.set(h.id, h.year);
    // Ровно один тайтл, вышедший не позже релиза.
    const ok = [...hits].filter(([, y]) => y == null || r.year == null || y <= r.year);
    if (ok.length !== 1) continue;
    cand.push({
      anilibriaId: Number(r.id),
      tmdbItemId: ok[0]![0],
      seasonNumber: p.season,
      title: String(r.title),
      anilibriaEpisodes: Number(r.am),
      seasonEpisodes: 0,
    });
  }
  const out: AnimeSeasonPair[] = [];
  const taken = new Set<string>();
  for (const c of cand) {
    const key = `${c.tmdbItemId}:${c.seasonNumber}`;
    if (taken.has(key) || cand.filter((x) => `${x.tmdbItemId}:${x.seasonNumber}` === key).length > 1) continue;
    const st = await db.execute<{ n: number; ani: number }>(sql`
      select count(e.id)::int as n,
        count(m.id) filter (where m.source_key like 'anilibria:%')::int as ani
      from seasons s join episodes e on e.season_id = s.id
      left join media m on m.episode_id = e.id
      where s.item_id = ${c.tmdbItemId} and s.number = ${c.seasonNumber}
    `);
    const row = (st.rows as Array<{ n: number; ani: number }>)[0];
    if (!row || Number(row.n) === 0 || Number(row.ani) > 0) continue;
    taken.add(key);
    out.push({ ...c, seasonEpisodes: Number(row.n) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Вливает релиз сезона в сезон N тайтла (серия k → SNEk), запоминает алиас. */
export async function absorbAnilibriaSeason(
  db: Db,
  anilibriaId: number,
  targetId: number,
  seasonNumber: number,
): Promise<number> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const src = await tx.execute<{ external_id: string; plot: string | null }>(sql`
      select external_id, plot from items where id = ${anilibriaId} and external_source = 'anilibria'
    `);
    const release = (src.rows as Array<{ external_id: string; plot: string | null }>)[0];
    if (!release) return 0;
    const season = await tx.execute<{ id: number }>(sql`
      select id from seasons where item_id = ${targetId} and number = ${seasonNumber}`);
    const seasonId = Number((season.rows as Array<{ id: number }>)[0]?.id ?? 0);
    if (!seasonId) return 0;
    const eps = await tx.execute<{ id: number }>(sql`
      select id from episodes where season_id = ${seasonId} order by number`);
    const target = (eps.rows as Array<{ id: number }>).map((r) => Number(r.id));

    const srcMedia = await tx.execute<{ id: number; ordinal: number | null; title: string | null; runtime: number | null }>(sql`
      select m.id, coalesce(e.orig_number, e.number, m.part_number) as ordinal, e.title, e.runtime
      from media m left join episodes e on e.id = m.episode_id
      where m.item_id = ${anilibriaId}
      order by ordinal
    `);
    let moved = 0;
    for (const m of srcMedia.rows as Array<{ id: number; ordinal: number | null; title: string | null; runtime: number | null }>) {
      const k = Number(m.ordinal ?? 0);
      if (k <= 0) continue;
      let epId = target[k - 1] ?? null;
      if (epId == null) {
        // Онгоинг убежал вперёд TMDb — серия в конец этого сезона.
        const e = await tx.execute<{ id: number }>(sql`
          insert into episodes (season_id, number, title, runtime)
          values (${seasonId}, (select coalesce(max(number), 0) + 1 from episodes where season_id = ${seasonId}),
            ${m.title}, ${Number(m.runtime ?? 0)})
          returning id`);
        epId = Number((e.rows as Array<{ id: number }>)[0]!.id);
      }
      await adoptIntoEpisode(tx, Number(m.id), targetId, epId);
      moved++;
    }
    await recordExternalAlias(tx, "anilibria", release.external_id, targetId, seasonNumber);
    await moveSocialAndDelete(tx, anilibriaId, targetId, release, "season");
    return moved;
  });
}
