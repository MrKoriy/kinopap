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
      select id, title, original_title, year from items where external_source = 'anilibria'
    ),
    t as (
      select id, title, original_title, year from items
      where external_source is null and tmdb_id is not null and type in ('serial', 'anime', 'movie')
    ),
    p as (
      select distinct on (a.id) a.id as aid, t.id as tid, a.title
      from a join t
        on (lower(a.title) = lower(t.title)
            or (a.original_title is not null and lower(a.original_title) = lower(t.original_title)))
       and coalesce(abs(a.year - t.year), 0) <= 1
      order by a.id, (lower(a.title) = lower(t.title)) desc, t.id
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
  type: "anime" | "movie",
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
    await tx.execute(sql`
      update items t set
        type = ${type},
        external_source = 'anilibria',
        external_id = ${release.external_id},
        plot = coalesce(t.plot, ${release.plot}),
        views = t.views + (select coalesce(views, 0) from items where id = ${anilibriaId}),
        updated_at = now()
      where t.id = ${targetId}`);
    await recordItemRedirect(tx, anilibriaId, targetId);
    await tx.execute(sql`delete from items where id = ${anilibriaId}`);
}
