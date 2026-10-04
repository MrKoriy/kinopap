/**
 * Заранее найденные раздачи (stream_sources): pre-resolve для «Смотреть».
 *
 * Фоновый stream-precheck (apps/worker) находит релизы на rutor, проверяет
 * их в TorrServer и складывает сюда — по строке на релиз. Резолвер при
 * клике сначала берёт good-записи и в rutor не ходит. Жалоба «не играет /
 * не та серия» переводит релиз в bad только для этой пары (item, media):
 * в соседней серии того же пака файл может быть вполне рабочим.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import type { StreamSourceStatus } from "../schema/enums";
import { episodes, items, media, seasons, streamSources } from "../schema/index";

/** Подряд проваленных проверок, после которых релиз считается мёртвым. */
export const STREAM_DEAD_AFTER_FAILS = 3;

export type StreamSourceRow = typeof streamSources.$inferSelect;

/** Релиз-кандидат из поиска (rutor) — то, что пишем в stream_sources. */
export interface StreamSourceCandidate {
  infohash: string;
  magnet: string;
  title: string;
  quality?: string | null;
  sizeBytes?: number | null;
  voices?: string[];
  seeds?: number;
  peers?: number;
  /** Индекс файла известен (релиз прогрет/проверен) — запишем и checked_at. */
  fileIndex?: number | null;
}

/** Всё, что резолверу нужно знать о паре (item, media) для поиска раздачи. */
export interface StreamResolveTarget {
  itemId: number;
  mediaId: number;
  episodeId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  type: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  absoluteNumber: number | null;
  externalSource: string | null;
  externalId: string | null;
  /** Фильм или первая серия — по ним судим, есть ли у тайтла источники вообще. */
  isEntryMedia: boolean;
}

/**
 * Контекст резолва пары (item, media): название, год, сезон/серия в
 * координатах источника и внешний id аниме. Раньше жил прямо в маршруте
 * media-links; теперь его же зовёт фоновый stream-precheck — правила
 * сопоставления AniLibria-серий обязаны совпадать в обоих местах.
 * null — пары нет (чужой media или item удалён).
 */
export async function streamResolveTarget(
  db: Db,
  itemId: number,
  mediaId: number,
): Promise<StreamResolveTarget | null> {
  const rows = await db
    .select({
      title: items.title,
      originalTitle: items.originalTitle,
      year: items.year,
      type: items.type,
      extSource: items.externalSource,
      extId: items.externalId,
      episodeId: media.episodeId,
      // Координаты источника: после перестройки сезонов «Сезон 12, серия 5»
      // у нас — это s01e245 у TMDb/AniLibria, и искать поток надо по ним.
      season: sql<number | null>`coalesce(${episodes.origSeason}, ${seasons.number})`,
      episode: sql<number | null>`coalesce(${episodes.origNumber}, ${episodes.number})`,
      sourceKey: media.sourceKey,
      absolute: episodes.absoluteNumber,
    })
    .from(media)
    .innerJoin(items, eq(items.id, media.itemId))
    .leftJoin(episodes, eq(episodes.id, media.episodeId))
    .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(and(eq(media.id, mediaId), eq(media.itemId, itemId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const ctxSeason = r.season == null ? null : Number(r.season);
  const ctxEpisode = r.episode == null ? null : Number(r.episode);
  // Источник решает media, а не тайтл: в TMDb-сериал влит релиз AniLibria —
  // его серии («anilibria:<release>:<ordinal>») играют HLS AniLibria, а
  // серии вне релиза (другие сезоны) идут торрентами, без подмены на
  // «серию k» релиза.
  const ani = /^anilibria:(\d+):(\d+)$/.exec(r.sourceKey ?? "");
  const isAniItem = r.extSource === "anilibria";
  const externalSource = ani
    ? "anilibria"
    : isAniItem && r.sourceKey == null && ctxSeason != null
      ? null
      : (r.extSource ?? null);
  const externalId = ani ? ani[1]! : externalSource ? (r.extId ?? null) : null;
  const type = ani ? "anime" : isAniItem && externalSource == null ? "serial" : r.type;
  // Фильм-релиз AniLibria без серий — без S/E (иначе rutor искал бы «s01e01»).
  const seasonNumber = ani && ctxSeason != null ? 1 : ctxSeason;
  const episodeNumber = ani && ctxEpisode != null ? Number(ani[2]) : ctxEpisode;
  return {
    itemId,
    mediaId,
    episodeId: r.episodeId ?? null,
    title: r.title,
    originalTitle: r.originalTitle ?? null,
    year: r.year ?? null,
    type,
    seasonNumber,
    episodeNumber,
    absoluteNumber: r.absolute ?? null,
    externalSource,
    externalId,
    isEntryMedia: ctxSeason == null || (ctxSeason <= 1 && (ctxEpisode ?? 1) <= 1),
  };
}

/** Все раздачи пары, лучшие первыми (good → проверенные → по сидам). */
export async function getStreamSources(db: Db, mediaId: number): Promise<StreamSourceRow[]> {
  const rows = await db.select().from(streamSources).where(eq(streamSources.mediaId, mediaId));
  return rows.sort(compareSources);
}

function compareSources(a: StreamSourceRow, b: StreamSourceRow): number {
  const rank = (r: StreamSourceRow) => (r.status === "good" ? 0 : r.status === "dead" ? 1 : 2);
  return (
    rank(a) - rank(b) ||
    Number(b.fileIndex != null && b.checkedAt != null) - Number(a.fileIndex != null && a.checkedAt != null) ||
    b.seeds - a.seeds ||
    a.id - b.id
  );
}

/**
 * Раздачи, которые можно отдать клику без похода в rutor: good, проверенные
 * в TorrServer (есть fileIndex и checked_at) не раньше `maxAgeMs` назад.
 * Непроверенные кандидаты сюда не попадают — для них нужен свежий поиск.
 */
export function usableStreamSources(
  rows: StreamSourceRow[],
  maxAgeMs: number,
  now = Date.now(),
): StreamSourceRow[] {
  return rows
    .filter(
      (r) =>
        r.status === "good" &&
        r.fileIndex != null &&
        r.checkedAt != null &&
        now - r.checkedAt.getTime() < maxAgeMs,
    )
    .sort(compareSources);
}

/** Хеши, которые для этой пары выдавать нельзя (жалобы зрителей). */
export function bannedStreamHashes(rows: StreamSourceRow[]): string[] {
  return rows.filter((r) => r.status === "bad").map((r) => r.infohash);
}

/**
 * Upsert найденных релизов. Существующим обновляем метаданные (сиды
 * меняются), статус bad НЕ трогаем — пожалованный релиз не воскресает от
 * того, что его снова нашёл поиск. Кандидат с fileIndex — проверенный:
 * пишем индекс, checked_at, сбрасываем счётчик неудач, dead → good.
 */
export async function recordStreamSources(
  db: Db,
  pair: { itemId: number; mediaId: number; episodeId?: number | null },
  candidates: StreamSourceCandidate[],
): Promise<void> {
  const seen = new Set<string>();
  const now = new Date();
  for (const c of candidates) {
    const hash = c.infohash.toLowerCase();
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    const checked = c.fileIndex != null;
    await db
      .insert(streamSources)
      .values({
        itemId: pair.itemId,
        mediaId: pair.mediaId,
        episodeId: pair.episodeId ?? null,
        infohash: hash,
        magnet: c.magnet,
        title: c.title.slice(0, 500),
        fileIndex: c.fileIndex ?? null,
        quality: c.quality?.slice(0, 32) ?? null,
        sizeBytes: c.sizeBytes ?? null,
        voices: (c.voices ?? []).slice(0, 16),
        seeds: c.seeds ?? 0,
        peers: c.peers ?? 0,
        status: "good",
        checkedAt: checked ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [streamSources.mediaId, streamSources.infohash],
        set: {
          magnet: c.magnet,
          title: c.title.slice(0, 500),
          quality: c.quality?.slice(0, 32) ?? null,
          sizeBytes: c.sizeBytes ?? null,
          voices: (c.voices ?? []).slice(0, 16),
          seeds: c.seeds ?? 0,
          peers: c.peers ?? 0,
          updatedAt: now,
          ...(checked
            ? {
                fileIndex: c.fileIndex,
                checkedAt: now,
                failCount: 0,
                status: sql`case when ${streamSources.status} = 'bad' then 'bad'::stream_source_status else 'good'::stream_source_status end`,
              }
            : {}),
        },
      });
  }
}

/**
 * Итог проверки релиза в TorrServer. Успех — good + fileIndex; провал —
 * fail_count+1, и после STREAM_DEAD_AFTER_FAILS подряд — dead. bad
 * (жалоба) проверкой не перетирается.
 */
export async function markStreamSourceChecked(
  db: Db,
  mediaId: number,
  infohash: string,
  result: { ok: true; fileIndex: number } | { ok: false },
): Promise<void> {
  const hash = infohash.toLowerCase();
  const where = and(eq(streamSources.mediaId, mediaId), eq(streamSources.infohash, hash));
  if (result.ok) {
    await db
      .update(streamSources)
      .set({
        fileIndex: result.fileIndex,
        checkedAt: new Date(),
        updatedAt: new Date(),
        failCount: 0,
        status: sql`case when ${streamSources.status} = 'bad' then 'bad'::stream_source_status else 'good'::stream_source_status end`,
      })
      .where(where);
    return;
  }
  await db
    .update(streamSources)
    .set({
      checkedAt: new Date(),
      updatedAt: new Date(),
      failCount: sql`${streamSources.failCount} + 1`,
      status: sql`case
        when ${streamSources.status} = 'bad' then 'bad'::stream_source_status
        when ${streamSources.failCount} + 1 >= ${STREAM_DEAD_AFTER_FAILS} then 'dead'::stream_source_status
        else ${streamSources.status} end`,
    })
    .where(where);
}

/**
 * Жалоба зрителя: релиз → bad для этой пары. Неизвестный хеш (резолв
 * был из L1 и в таблицу не попал) заводим строкой сразу в bad.
 * Возвращает новый статус-счётчик жалоб.
 */
export async function reportStreamSource(
  db: Db,
  pair: { itemId: number; mediaId: number; episodeId?: number | null },
  infohash: string,
): Promise<{ reportCount: number }> {
  const hash = infohash.toLowerCase();
  const now = new Date();
  const [row] = await db
    .insert(streamSources)
    .values({
      itemId: pair.itemId,
      mediaId: pair.mediaId,
      episodeId: pair.episodeId ?? null,
      infohash: hash,
      magnet: `magnet:?xt=urn:btih:${hash}`,
      title: "",
      status: "bad",
      reportCount: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [streamSources.mediaId, streamSources.infohash],
      set: {
        status: "bad",
        reportCount: sql`${streamSources.reportCount} + 1`,
        updatedAt: now,
      },
    })
    .returning({ reportCount: streamSources.reportCount });
  return { reportCount: row?.reportCount ?? 1 };
}

/**
 * Пересчёт items.playable: есть хоть одна проверенная good-раздача (или
 * готовый HLS — `hasDirect`) → true; проверяли и ничего живого (`checked`)
 * → false; иначе оставляем как было (не знаем — не обещаем и не прячем).
 */
export async function refreshItemPlayable(
  db: Db,
  itemId: number,
  opts: { checked: boolean; hasDirect?: boolean },
): Promise<void> {
  if (opts.hasDirect) {
    await db.update(items).set({ playable: true }).where(eq(items.id, itemId));
    return;
  }
  await db.execute(sql`
    update items set playable = case
      when exists (
        select 1 from stream_sources ss
        where ss.item_id = ${itemId} and ss.status = 'good' and ss.checked_at is not null
      ) then true
      when ${opts.checked} then false
      else playable end
    where id = ${itemId}
  `);
}

/** Количество раздач по статусам — для логов precheck и отчётов. */
export async function streamSourceStats(db: Db): Promise<Record<StreamSourceStatus, number>> {
  const rows = await db
    .select({ status: streamSources.status, n: sql<number>`count(*)::int` })
    .from(streamSources)
    .groupBy(streamSources.status);
  const out: Record<StreamSourceStatus, number> = { good: 0, bad: 0, dead: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

/** Цель прогрева головы файла в TorrServer. */
export interface HeadWarmTarget {
  itemId: number;
  mediaId: number;
  infohash: string;
  fileIndex: number;
  seeds: number;
}

/**
 * Что держать «горячим» (голова файла в кэше TorrServer): лучшая проверенная
 * раздача у продолжающихся просмотров (14 дней) и у топа по просмотрам.
 * Одна раздача на media, не больше `limit` штук.
 */
export async function headWarmTargets(db: Db, limit: number): Promise<HeadWarmTarget[]> {
  if (limit <= 0) return [];
  const res = await db.execute<{
    item_id: number;
    media_id: number;
    infohash: string;
    file_index: number;
    seeds: number;
  }>(sql`
    with best as (
      select distinct on (ss.media_id) ss.item_id, ss.media_id, ss.infohash, ss.file_index, ss.seeds
      from stream_sources ss
      where ss.status = 'good' and ss.file_index is not null and ss.checked_at is not null
      order by ss.media_id, ss.seeds desc, ss.id
    ),
    watching as (
      select distinct wp.media_id from watch_progress wp
      where wp.updated_at > now() - interval '14 days' and wp.media_id is not null
    )
    select b.item_id, b.media_id, b.infohash, b.file_index, b.seeds
    from best b
    join items i on i.id = b.item_id
    left join watching w on w.media_id = b.media_id
    order by (w.media_id is null), i.views desc nulls last, b.seeds desc, b.media_id
    limit ${limit}
  `);
  const rows = ((res as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as Array<{
    item_id: number;
    media_id: number;
    infohash: string;
    file_index: number;
    seeds: number;
  }>;
  return rows.map((r) => ({
    itemId: Number(r.item_id),
    mediaId: Number(r.media_id),
    infohash: r.infohash,
    fileIndex: Number(r.file_index),
    seeds: Number(r.seeds),
  }));
}

/**
 * Пары, которым пора на перепроверку: у media есть good-раздача, но
 * проверяли её раньше `olderThanMs` назад. Популярное — первым.
 */
export async function staleStreamPairs(
  db: Db,
  opts: { olderThanMs: number; limit: number },
): Promise<Array<{ itemId: number; mediaId: number }>> {
  if (opts.limit <= 0) return [];
  const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString();
  const res = await db.execute<{ item_id: number; media_id: number }>(sql`
    select ss.item_id, ss.media_id
    from stream_sources ss
    join items i on i.id = ss.item_id
    where ss.status = 'good'
    group by ss.item_id, ss.media_id, i.views
    having max(ss.checked_at) is null or max(ss.checked_at) < ${cutoff}::timestamptz
    order by i.views desc nulls last, ss.media_id
    limit ${opts.limit}
  `);
  const rows = ((res as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as Array<{
    item_id: number;
    media_id: number;
  }>;
  return rows.map((r) => ({ itemId: Number(r.item_id), mediaId: Number(r.media_id) }));
}

/** media, у которых уже есть свежепроверенная good-раздача (для фильтра целей). */
export async function mediaWithFreshSources(
  db: Db,
  mediaIds: number[],
  freshMs: number,
): Promise<Set<number>> {
  if (mediaIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - freshMs);
  const rows = await db
    .select({ mediaId: streamSources.mediaId })
    .from(streamSources)
    .where(
      and(
        inArray(streamSources.mediaId, mediaIds),
        eq(streamSources.status, "good"),
        sql`${streamSources.checkedAt} > ${cutoff.toISOString()}::timestamptz`,
      ),
    );
  return new Set(rows.map((r) => r.mediaId));
}
