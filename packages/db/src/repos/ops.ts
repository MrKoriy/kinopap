/**
 * Эксплуатация: курсоры Catalog Daemon (sync_state), RUM-метрики клиентов
 * и точечное обновление метаданных тайтлов из TMDb (/changes, дыры).
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { items, rumEvents, syncState } from "../schema/index";

/* ---------------- sync_state ---------------- */

export interface SyncStateRow {
  key: string;
  cursor: string | null;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

export async function getSyncState(db: Db, key: string): Promise<SyncStateRow | null> {
  const rows = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  const r = rows[0];
  return r
    ? { key: r.key, cursor: r.cursor, lastRunAt: r.lastRunAt, lastOkAt: r.lastOkAt, stats: r.stats ?? null, error: r.error }
    : null;
}

/**
 * Итог прогона задачи. ok=false — курсор не двигаем (повторим с того же
 * места), пишем ошибку; ok=true — курсор (если задан) и last_ok_at.
 */
export async function recordSyncRun(
  db: Db,
  key: string,
  run: { ok: boolean; cursor?: string | null; stats?: Record<string, unknown>; error?: string | null },
): Promise<void> {
  const now = new Date();
  const base = {
    lastRunAt: now,
    stats: run.stats ?? null,
    error: run.ok ? null : (run.error ?? "failed").slice(0, 1000),
    updatedAt: now,
  };
  const set = run.ok
    ? { ...base, lastOkAt: now, ...(run.cursor !== undefined ? { cursor: run.cursor } : {}) }
    : base;
  await db
    .insert(syncState)
    .values({ key, ...set, cursor: run.ok ? (run.cursor ?? null) : null })
    .onConflictDoUpdate({ target: syncState.key, set });
}

export async function listSyncState(db: Db): Promise<SyncStateRow[]> {
  const rows = await db.select().from(syncState).orderBy(syncState.key);
  return rows.map((r) => ({
    key: r.key,
    cursor: r.cursor,
    lastRunAt: r.lastRunAt,
    lastOkAt: r.lastOkAt,
    stats: r.stats ?? null,
    error: r.error,
  }));
}

/* ---------------- RUM ---------------- */

export interface RumEventInput {
  name: string;
  value: number;
  page?: string | null;
  itemId?: number | null;
  rating?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function insertRumEvents(db: Db, events: RumEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  await db.insert(rumEvents).values(
    events.map((e) => ({
      name: e.name,
      value: e.value,
      page: e.page ?? null,
      itemId: e.itemId ?? null,
      rating: e.rating ?? null,
      meta: e.meta ?? null,
    })),
  );
  return events.length;
}

export interface RumMetricSummary {
  name: string;
  count: number;
  p50: number;
  p75: number;
  p95: number;
  /** Доля оценок good (web-vitals) — null, если оценок нет. */
  goodShare: number | null;
}

export interface RumSummary {
  hours: number;
  metrics: RumMetricSummary[];
  /** TTFF: сколько стартов потребовали живого резолва (rutor/TorrServer). */
  ttff: { starts: number; cold: number; coldShare: number | null; p50Cold: number | null; p50Warm: number | null };
}

/** Сводка за последние N часов: перцентили по метрикам и доля холодных стартов. */
export async function rumSummary(db: Db, hours = 24): Promise<RumSummary> {
  const since = sql`now() - make_interval(hours => ${hours})`;
  const res = await db.execute<{
    name: string;
    n: number;
    p50: number;
    p75: number;
    p95: number;
    good: number | null;
  }>(sql`
    select name, count(*)::int as n,
      percentile_cont(0.5) within group (order by value) as p50,
      percentile_cont(0.75) within group (order by value) as p75,
      percentile_cont(0.95) within group (order by value) as p95,
      case when count(rating) > 0 then avg(case when rating = 'good' then 1.0 else 0.0 end) end as good
    from rum_events where created_at > ${since}
    group by name order by name
  `);
  const ttff = await db.execute<{ starts: number; cold: number; p50_cold: number | null; p50_warm: number | null }>(sql`
    select count(*)::int as starts,
      count(*) filter (where (meta->>'cold')::boolean)::int as cold,
      percentile_cont(0.5) within group (order by value) filter (where (meta->>'cold')::boolean) as p50_cold,
      percentile_cont(0.5) within group (order by value) filter (where not coalesce((meta->>'cold')::boolean, false)) as p50_warm
    from rum_events where name = 'TTFF' and created_at > ${since}
  `);
  const round = (v: unknown) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);
  const t = (ttff.rows as Array<{ starts: number; cold: number; p50_cold: number | null; p50_warm: number | null }>)[0];
  const starts = Number(t?.starts ?? 0);
  const cold = Number(t?.cold ?? 0);
  return {
    hours,
    metrics: (res.rows as Array<{ name: string; n: number; p50: number; p75: number; p95: number; good: number | null }>).map(
      (r) => ({
        name: r.name,
        count: Number(r.n),
        p50: round(r.p50) ?? 0,
        p75: round(r.p75) ?? 0,
        p95: round(r.p95) ?? 0,
        goodShare: round(r.good),
      }),
    ),
    ttff: {
      starts,
      cold,
      coldShare: starts > 0 ? round(cold / starts) : null,
      p50Cold: round(t?.p50_cold),
      p50Warm: round(t?.p50_warm),
    },
  };
}

export async function purgeRumEvents(db: Db, days = 30): Promise<number> {
  const res = await db.execute(sql`delete from rum_events where created_at < now() - make_interval(days => ${days})`);
  return Number((res as { rowCount?: number }).rowCount ?? 0);
}

/* ---------------- TMDb refresh ---------------- */

export interface TmdbRefreshRow {
  id: number;
  tmdbId: number;
  tmdbType: "movie" | "tv";
  type: string;
  posterMedium: string | null;
  backdropUrl: string | null;
  plot: string | null;
  runtimeAvg: number | null;
  externalSource: string | null;
  /** Сколько серий у нас (для сериалов) — сравнение с number_of_episodes. */
  episodes: number;
}

const refreshCols = {
  id: items.id,
  tmdbId: items.tmdbId,
  tmdbType: items.tmdbType,
  type: items.type,
  posterMedium: items.posterMedium,
  backdropUrl: items.backdropUrl,
  plot: items.plot,
  runtimeAvg: items.runtimeAvg,
  externalSource: items.externalSource,
  episodes: sql<number>`(select count(*)::int from seasons s join episodes e on e.season_id = s.id where s.item_id = "items"."id" and s.number > 0)`,
};

function toRefreshRow(r: {
  id: number;
  tmdbId: number | null;
  tmdbType: string | null;
  type: string;
  posterMedium: string | null;
  backdropUrl: string | null;
  plot: string | null;
  runtimeAvg: number | null;
  externalSource: string | null;
  episodes: number;
}): TmdbRefreshRow {
  return {
    ...r,
    tmdbId: Number(r.tmdbId),
    tmdbType: r.tmdbType === "tv" ? "tv" : "movie",
    episodes: Number(r.episodes ?? 0),
  };
}

/**
 * Наши тайтлы из списка изменившихся у TMDb id, которые давно не сверяли
 * (staleHours): /changes за день повторяется каждые 30 мин, а тянуть детали
 * одного тайтла чаще раза в несколько часов незачем.
 */
export async function listItemsForTmdbRefresh(
  db: Db,
  tmdbType: "movie" | "tv",
  tmdbIds: number[],
  opts: { staleHours?: number; limit?: number } = {},
): Promise<TmdbRefreshRow[]> {
  if (tmdbIds.length === 0) return [];
  const out: TmdbRefreshRow[] = [];
  const limit = opts.limit ?? 300;
  const stale = sql`now() - make_interval(hours => ${opts.staleHours ?? 6})`;
  for (let i = 0; i < tmdbIds.length && out.length < limit; i += 2000) {
    const chunk = tmdbIds.slice(i, i + 2000);
    const rows = await db
      .select(refreshCols)
      .from(items)
      .where(
        and(
          eq(items.tmdbType, tmdbType),
          inArray(items.tmdbId, chunk),
          or(isNull(items.tmdbRefreshedAt), lt(items.tmdbRefreshedAt, stale)),
        ),
      )
      .orderBy(desc(items.views))
      .limit(limit - out.length);
    out.push(...rows.map(toRefreshRow));
  }
  return out;
}

/**
 * Дыры метаданных (gap-filler воркера): тайтлы TMDb без бэкдропа, описания
 * или длительности, которые ни разу не сверяли. Популярные первыми.
 */
export async function listItemsWithMetadataGaps(db: Db, limit: number): Promise<TmdbRefreshRow[]> {
  const rows = await db
    .select(refreshCols)
    .from(items)
    .where(
      and(
        isNotNull(items.tmdbId),
        isNotNull(items.tmdbType),
        isNull(items.tmdbRefreshedAt),
        or(isNull(items.backdropUrl), isNull(items.plot), isNull(items.runtimeAvg)),
      ),
    )
    .orderBy(desc(items.views), desc(items.rating))
    .limit(limit);
  return rows.map(toRefreshRow);
}

export interface TmdbRefreshPatch {
  tmdbRating?: number | null;
  tmdbVotes?: number | null;
  /** Общий рейтинг карточки — только у тайтлов, пришедших из TMDb. */
  rating?: number | null;
  plot?: string | null;
  posterSmall?: string | null;
  posterMedium?: string | null;
  posterBig?: string | null;
  backdropUrl?: string | null;
  runtimeAvg?: number | null;
  finished?: boolean | null;
  /** Новые серии у TMDb — пометка для догидрации сезонов. */
  episodesBehind?: boolean;
}

/**
 * Применить свежие метаданные TMDb. Сменился постер или появился бэкдроп —
 * сбрасываем свои нарезки, ночной images.ts нарежет заново. updated_at
 * двигается только при реальных изменениях (по нему воркер сбрасывает ISR).
 */
export async function applyTmdbRefresh(
  db: Db,
  row: Pick<TmdbRefreshRow, "id" | "posterMedium" | "backdropUrl" | "plot" | "runtimeAvg">,
  patch: TmdbRefreshPatch,
): Promise<{ changed: boolean; imagesReset: boolean }> {
  const set: Partial<typeof items.$inferInsert> = { tmdbRefreshedAt: new Date() };
  let changed = false;
  let imagesReset = false;
  if (patch.tmdbRating != null) set.tmdbRating = patch.tmdbRating;
  if (patch.tmdbVotes != null) set.tmdbVotes = patch.tmdbVotes;
  if (patch.rating != null && patch.rating > 0) set.rating = patch.rating;
  if (patch.finished != null) set.finished = patch.finished;
  if (patch.plot && !row.plot) {
    set.plot = patch.plot;
    changed = true;
  }
  if (patch.runtimeAvg && !row.runtimeAvg) {
    set.runtimeAvg = patch.runtimeAvg;
    changed = true;
  }
  if (patch.posterMedium && patch.posterMedium !== row.posterMedium) {
    set.posterSmall = patch.posterSmall ?? patch.posterMedium;
    set.posterMedium = patch.posterMedium;
    set.posterBig = patch.posterBig ?? patch.posterMedium;
    changed = true;
    imagesReset = true;
  }
  if (patch.backdropUrl && patch.backdropUrl !== row.backdropUrl) {
    set.backdropUrl = patch.backdropUrl;
    changed = true;
    imagesReset = true;
  }
  if (patch.episodesBehind) {
    set.tmdbChangedAt = new Date();
  }
  if (imagesReset) {
    set.imagesCheckedAt = null;
    set.posterHash = null;
    set.backdropHash = null;
  }
  if (changed) set.updatedAt = new Date();
  await db.update(items).set(set).where(eq(items.id, row.id));
  return { changed, imagesReset };
}

/** Сериалы, у которых TMDb сообщил о новых сериях (для gap-filler API). */
export async function listSerialsBehindTmdb(db: Db, limit: number): Promise<Array<{ id: number; tmdbId: number }>> {
  const rows = await db
    .select({ id: items.id, tmdbId: items.tmdbId })
    .from(items)
    // Перестроенные (эпизод-группы, куры, override) не трогаем: гидрация по
    // сезонам TMDb легла бы поверх своей раскладки. «source»/«flat» — это
    // раскладка источника, её догонять можно.
    .where(
      and(
        isNotNull(items.tmdbChangedAt),
        isNotNull(items.tmdbId),
        or(isNull(items.seasonLayout), inArray(items.seasonLayout, ["source", "flat"])),
      ),
    )
    .orderBy(desc(items.views))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, tmdbId: Number(r.tmdbId) }));
}

export async function clearSerialBehindTmdb(db: Db, itemId: number): Promise<void> {
  await db.update(items).set({ tmdbChangedAt: null }).where(eq(items.id, itemId));
}
