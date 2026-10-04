/**
 * Качество каталога: выборки для ночного quality-audit, таблица аномалий и
 * ручные раскладки сезонов (season_overrides).
 */
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { qualityAnomalies, type SeasonOverrideLayout, seasonOverrides } from "../schema/index";
import { applySeasonLayout, flatEpisodes } from "./seasons";

export type AnomalyKind =
  | "long_season"
  | "numbering_gap"
  | "duplicate_episode"
  | "duplicate_item"
  | "no_source"
  | "no_episodes";

export interface AnomalyInput {
  itemId: number;
  kind: AnomalyKind;
  details: Record<string, unknown>;
  status?: "open" | "fixed";
}

/**
 * Upsert аномалий одного вида и закрытие тех, что больше не воспроизводятся.
 * ignored (решение человека) не переоткрываем и не трогаем.
 */
export async function syncAnomalies(
  db: Db,
  kind: AnomalyKind,
  found: AnomalyInput[],
): Promise<{ opened: number; resolved: number }> {
  const now = new Date();
  for (let i = 0; i < found.length; i += 200) {
    const chunk = found.slice(i, i + 200);
    await db
      .insert(qualityAnomalies)
      .values(chunk.map((a) => ({ itemId: a.itemId, kind, details: a.details, status: a.status ?? "open" })))
      .onConflictDoUpdate({
        target: [qualityAnomalies.itemId, qualityAnomalies.kind],
        set: {
          details: sql`excluded.details`,
          status: sql`case when ${qualityAnomalies.status} = 'ignored' then 'ignored' else excluded.status end`,
          resolvedAt: sql`case when ${qualityAnomalies.status} = 'ignored' then ${qualityAnomalies.resolvedAt} else null end`,
          updatedAt: now,
        },
      });
  }
  const ids = found.map((a) => a.itemId);
  const stale = await db
    .update(qualityAnomalies)
    .set({ status: "resolved", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(qualityAnomalies.kind, kind),
        inArray(qualityAnomalies.status, ["open", "fixed"]),
        ids.length > 0 ? notInArray(qualityAnomalies.itemId, ids) : undefined,
      ),
    )
    .returning({ id: qualityAnomalies.id });
  return { opened: found.length, resolved: stale.length };
}

export async function listOpenAnomalies(db: Db, kind?: AnomalyKind, limit = 200) {
  return db
    .select()
    .from(qualityAnomalies)
    .where(and(eq(qualityAnomalies.status, "open"), kind ? eq(qualityAnomalies.kind, kind) : undefined))
    .orderBy(qualityAnomalies.kind, qualityAnomalies.itemId)
    .limit(limit);
}

/* ---------- Выборки аудита ---------- */

const rows = <T>(res: { rows: unknown[] }) => res.rows as T[];

/** Сезоны длиннее порога (спецвыпуски «Сезон 0» не в счёт). */
export async function findLongSeasons(db: Db, threshold: number) {
  return rows<{ item_id: number; season: number; episodes: number; layout: string | null }>(
    await db.execute(sql`
      select s.item_id, s.number as season, count(e.id)::int as episodes, i.season_layout as layout
      from seasons s join episodes e on e.season_id = s.id join items i on i.id = s.item_id
      where s.number > 0
      group by s.item_id, s.number, i.season_layout
      having count(e.id) > ${threshold}
    `),
  );
}

/** Номера серий по сезонам, где есть дыра или нумерация не с 1. */
export async function findSeasonNumberings(db: Db) {
  return rows<{ item_id: number; season: number; numbers: number[] }>(
    await db.execute(sql`
      select s.item_id, s.number as season, array_agg(e.number order by e.number) as numbers
      from seasons s join episodes e on e.season_id = s.id
      where s.number > 0
      group by s.item_id, s.number
      having max(e.number) <> count(*) or min(e.number) <> 1
    `),
  );
}

/** Одна и та же серия источника дважды (после перестроек/склеек). */
export async function findDuplicateEpisodes(db: Db) {
  return rows<{ item_id: number; orig_season: number; orig_number: number; n: number }>(
    await db.execute(sql`
      select s.item_id, coalesce(e.orig_season, s.number) as orig_season,
        coalesce(e.orig_number, e.number) as orig_number, count(*)::int as n
      from episodes e join seasons s on s.id = e.season_id
      where s.number > 0
      group by s.item_id, coalesce(e.orig_season, s.number), coalesce(e.orig_number, e.number)
      having count(*) > 1
    `),
  );
}

/** Карточки-дубли: одно название + год + тип. */
export async function findDuplicateItems(db: Db) {
  return rows<{ ids: number[]; title: string; year: number | null; type: string }>(
    await db.execute(sql`
      select array_agg(id order by views desc, id) as ids, min(title) as title, year, type::text as type
      from items
      group by lower(title), year, type
      having count(*) > 1
    `),
  );
}

/** Тайтлы, у которых резолв дважды подряд не нашёл раздачу. */
export async function findNoSourceItems(db: Db, minFails = 2) {
  return rows<{ id: number; fails: number; at: string | null }>(
    await db.execute(sql`
      select id, no_source_count as fails, no_source_at as at from items where no_source_count >= ${minFails}
    `),
  );
}

/** Сериалы без единой серии, которые гидрация TMDb не спасёт (нет tmdb_id). */
export async function findSerialsWithoutEpisodes(db: Db) {
  return rows<{ id: number; tmdb_id: number | null }>(
    await db.execute(sql`
      select i.id, i.tmdb_id from items i
      where i.type in ('serial', 'docuserial', 'tvshow')
        and not exists (select 1 from seasons s join episodes e on e.season_id = s.id where s.item_id = i.id)
        and i.created_at < now() - interval '1 day'
    `),
  );
}

/** Автофикс: пустые сезоны (без серий) — мусор после склеек и перестроек. */
export async function deleteEmptySeasons(db: Db): Promise<number> {
  const res = await db.execute(sql`
    delete from seasons s where not exists (select 1 from episodes e where e.season_id = s.id)
    returning s.id
  `);
  return res.rows.length;
}

/* ---------- Ручные раскладки ---------- */

export async function upsertSeasonOverride(
  db: Db,
  itemId: number,
  layout: SeasonOverrideLayout,
  note?: string | null,
): Promise<void> {
  const now = new Date();
  await db
    .insert(seasonOverrides)
    .values({ itemId, layout, note: note ?? null })
    .onConflictDoUpdate({ target: seasonOverrides.itemId, set: { layout, note: note ?? null, updatedAt: now } });
}

/** Раскладки, которые ещё не применены или изменены после применения. */
export async function listPendingSeasonOverrides(db: Db) {
  return db
    .select()
    .from(seasonOverrides)
    .where(or(isNull(seasonOverrides.appliedAt), sql`${seasonOverrides.appliedAt} < ${seasonOverrides.updatedAt}`));
}

/**
 * Применяет ручную раскладку: координаты источника [S, E] → серии тайтла
 * (по orig_*), дальше — общий applySeasonLayout (серии переносятся, id и
 * прогресс сохраняются). Ненайденные координаты просто пропускаются.
 */
export async function applySeasonOverride(
  db: Db,
  itemId: number,
  layout: SeasonOverrideLayout,
): Promise<{ seasons: number; episodes: number; unmatched: number }> {
  const flat = await flatEpisodes(db, itemId);
  const byOrig = new Map(flat.map((e) => [`${e.origSeason}:${e.origNumber}`, e.id]));
  let unmatched = 0;
  const groups = layout.groups.map((g) => ({
    title: g.title,
    episodeIds: g.eps
      .map(([s, e]) => {
        const id = byOrig.get(`${s}:${e}`);
        if (id == null) unmatched++;
        return id;
      })
      .filter((id): id is number => id != null),
  }));
  const res = await applySeasonLayout(db, itemId, "override", groups);
  await db
    .update(seasonOverrides)
    .set({ appliedAt: new Date() })
    .where(eq(seasonOverrides.itemId, itemId));
  return { ...res, unmatched };
}
