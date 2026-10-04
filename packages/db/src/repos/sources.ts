/**
 * Кэш zero-storage резолва: ссылки и прогретый релиз по паре (item, media).
 *
 * Раньше кэш жил в памяти API и умирал при каждом рестарте — после деплоя
 * приходилось заново ходить в rutor (до 12с) и пере-прогревать торрент,
 * из-за чего пропадали аудио-дорожки. Здесь источник правды — БД, а
 * in-memory Map в API остаётся горячим L1 поверх неё.
 */

import type { AudioTrack, IntroMarker, MediaFile, WarmRelease } from "@zal/api-client";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { mediaSources } from "../schema/index";

export interface CachedSource {
  itemId: number;
  mediaId: number;
  files: MediaFile[];
  audios: AudioTrack[];
  intro: IntroMarker | null;
  /** Хеш и индекс файла в TorrServer; null — прогрев ещё идёт или провалился. */
  warm: WarmRelease | null;
  resolvedAt: Date;
}

/** Запись пригодна, если резолвился не раньше `maxAgeMs` назад. */
export function isSourceFresh(row: { resolvedAt: Date }, maxAgeMs: number, now = Date.now()): boolean {
  return now - row.resolvedAt.getTime() < maxAgeMs;
}

/**
 * Потолок массивов в jsonb: резолв приносит до ~8 релизов с дорожками,
 * аномально длинный список — признак битого ответа источника, тащить
 * его в кэш незачем.
 */
const MAX_CACHED_TRACKS = 64;

function clampTracks<T>(list: T[]): T[] {
  return list.length > MAX_CACHED_TRACKS ? list.slice(0, MAX_CACHED_TRACKS) : list;
}

export async function getSource(
  db: Db,
  itemId: number,
  mediaId: number,
): Promise<CachedSource | null> {
  const rows = await db
    .select()
    .from(mediaSources)
    .where(and(eq(mediaSources.itemId, itemId), eq(mediaSources.mediaId, mediaId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Полная запись результата резолва (upsert по паре item/media). */
export async function saveSource(
  db: Db,
  input: Omit<CachedSource, "resolvedAt">,
): Promise<void> {
  const at = new Date();
  const files = clampTracks(input.files);
  const audios = clampTracks(input.audios);
  await db
    .insert(mediaSources)
    .values({ ...input, files, audios, resolvedAt: at })
    .onConflictDoUpdate({
      target: [mediaSources.itemId, mediaSources.mediaId],
      set: {
        files,
        audios,
        intro: input.intro,
        warm: input.warm,
        resolvedAt: at,
      },
    });
}

/**
 * Точечное обновление: warm доехал фоном, аудио-дорожки доложены пробой.
 * Записи может ещё не быть (полный saveSource допишет всё разом) — тогда
 * это no-op: без files строка с одиноким warm не должна рождаться.
 */
export async function patchSource(
  db: Db,
  itemId: number,
  mediaId: number,
  patch: { warm?: WarmRelease | null; audios?: AudioTrack[] },
): Promise<void> {
  const set: Partial<typeof mediaSources.$inferInsert> = {};
  if (patch.warm !== undefined) set.warm = patch.warm;
  if (patch.audios !== undefined) set.audios = patch.audios;
  if (Object.keys(set).length === 0) return;
  await db
    .update(mediaSources)
    .set(set)
    .where(and(eq(mediaSources.itemId, itemId), eq(mediaSources.mediaId, mediaId)));
}

/** Сброс снимка резолва пары: после жалобы на раздачу собираем ссылки заново. */
export async function deleteSource(db: Db, itemId: number, mediaId: number): Promise<void> {
  await db
    .delete(mediaSources)
    .where(and(eq(mediaSources.itemId, itemId), eq(mediaSources.mediaId, mediaId)));
}

/** Гигиена: протухшие записи кэша (старше `maxAgeMs`) удаляем. */
export async function purgeStaleSources(db: Db, maxAgeMs: number): Promise<number> {
  const deleted = await db
    .delete(mediaSources)
    .where(lt(mediaSources.resolvedAt, new Date(Date.now() - maxAgeMs)));
  // node-postgres отдаёт rowCount, PGlite — changes; берём что есть.
  return deleted.rowCount ?? deleted.changes ?? 0;
}

/** Пара для фонового прогрева; mediaId=null — у тайтла ещё нет media-строки. */
export interface PrewarmTarget {
  itemId: number;
  mediaId: number | null;
  /** Чем меньше, тем раньше: 0 — продолжение просмотра, 1 — подписки/избранное, 2 — топ. */
  priority: number;
}

/**
 * Что прогреть заранее, чтобы клик «Смотреть» не ходил в rutor/TorrServer.
 *
 * Источники по убыванию ценности: следующая серия у тех, кто смотрел за
 * последние 14 дней (или текущая, если не досмотрена); первая серия/часть
 * тайтлов из подписок и избранного; топ каталога по просмотрам и рейтингу;
 * плюс явный список id (ленты главной). Пары, у которых свежий кэш
 * (`freshMs`), отсекаются в SQL.
 */
export async function prewarmCandidates(
  db: Db,
  opts: {
    limit: number;
    topLimit: number;
    extraItemIds?: number[];
    freshMs: number;
    /**
     * Что считать «уже готово»: снимок резолва (media_sources, прогрев API)
     * или проверенная раздача (stream_sources, stream-precheck воркера).
     */
    freshness?: "media_sources" | "stream_sources";
  },
): Promise<PrewarmTarget[]> {
  const extra = (opts.extraItemIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  const extraArr = sql.raw(`ARRAY[${extra.length ? extra.join(",") : "NULL"}]::int[]`);
  const freshBefore = new Date(Date.now() - opts.freshMs);
  const freshExists =
    opts.freshness === "stream_sources"
      ? sql`
      select 1 from stream_sources ss
      where d.media_id is not null and ss.media_id = d.media_id
        and ss.status = 'good' and ss.checked_at > ${freshBefore.toISOString()}::timestamptz`
      : sql`
      select 1 from media_sources ms
      where ms.item_id = d.item_id
        and d.media_id is not null and ms.media_id = d.media_id
        and ms.resolved_at > ${freshBefore.toISOString()}::timestamptz`;
  const res = await db.execute<{ item_id: number; media_id: number | null; priority: number }>(sql`
    with recent as (
      select distinct on (wp.item_id) wp.item_id, wp.media_id, wp.completed_at
      from watch_progress wp
      where wp.updated_at > now() - interval '14 days'
      order by wp.item_id, wp.updated_at desc
    ),
    recent_next as (
      select r.item_id,
        coalesce(
          case when r.completed_at is not null then (
            select m2.id
            from media m1
            join episodes e1 on e1.id = m1.episode_id
            join seasons s1 on s1.id = e1.season_id
            join seasons s2 on s2.item_id = s1.item_id
            join episodes e2 on e2.season_id = s2.id
            join media m2 on m2.episode_id = e2.id
            where m1.id = r.media_id
              and (s2.number, e2.number) > (s1.number, e1.number)
            order by s2.number, e2.number
            limit 1
          ) end,
          r.media_id
        ) as media_id,
        0 as priority
      from recent r
    ),
    pool as (
      select item_id, 1 as priority from subscriptions
      union all select item_id, 1 from favorites
      union all select unnest(${extraArr}), 1
      union all select id, 2 from (
        select id from items
        order by views desc nulls last, rating desc nulls last
        limit ${opts.topLimit}
      ) t
    ),
    pool_first as (
      select p.item_id, min(p.priority) as priority,
        (select m.id from media m
           left join episodes e on e.id = m.episode_id
           left join seasons s on s.id = e.season_id
          where m.item_id = p.item_id
          order by (s.number = 0) nulls first, s.number nulls first,
                   e.number nulls first, m.part_number, m.id
          limit 1) as media_id
      from pool p
      where p.item_id is not null
      group by p.item_id
    ),
    allc as (
      select item_id, media_id, priority from recent_next
      union all select item_id, media_id, priority from pool_first
    ),
    dedup as (
      select distinct on (item_id, coalesce(media_id, 0)) item_id, media_id, priority
      from allc
      order by item_id, coalesce(media_id, 0), priority
    )
    select d.item_id, d.media_id, d.priority
    from dedup d
    join items i on i.id = d.item_id
    where not exists (${freshExists})
    order by d.priority, i.views desc nulls last, d.item_id
    limit ${opts.limit}
  `);
  const rows = ((res as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as Array<{
    item_id: number;
    media_id: number | null;
    priority: number;
  }>;
  return rows.map((r) => ({
    itemId: Number(r.item_id),
    mediaId: r.media_id == null ? null : Number(r.media_id),
    priority: Number(r.priority),
  }));
}
