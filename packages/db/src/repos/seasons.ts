/**
 * Перестройка сезонов: «Блич» с 354 сериями в одном сезоне → арки по ~25.
 *
 * Источники (TMDb, AniLibria) часто кладут длинные аниме и мыльные оперы в
 * один сезон. Раскладку берём снаружи (эпизод-группы TMDb) и применяем на
 * месте: серии ПЕРЕНОСЯТСЯ между сезонами, а не пересоздаются — у media,
 * прогресса просмотра и закладок те же id, ничего не теряется.
 *
 * Исходные координаты серии (orig_season/orig_number) сохраняются: резолвер
 * ищет поток по ним («s01e245», ordinal AniLibria), и повторный импорт
 * находит серию по ним же, а не создаёт дубль в «Сезоне 1».
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { items } from "../schema/index";

export interface FlatEpisode {
  id: number;
  seasonId: number;
  seasonNumber: number;
  number: number;
  /** Координаты у источника (с учётом прежних перестроек). */
  origSeason: number;
  origNumber: number;
}

const intArray = (ids: number[]) =>
  sql.raw(`ARRAY[${ids.filter((n) => Number.isInteger(n)).join(",") || "NULL"}]::int[]`);

/** Серии тайтла (без спецвыпусков «Сезон 0») в порядке просмотра. */
export async function flatEpisodes(db: Db, itemId: number): Promise<FlatEpisode[]> {
  const res = await db.execute<{
    id: number;
    season_id: number;
    season_number: number;
    number: number;
    orig_season: number;
    orig_number: number;
  }>(sql`
    select e.id, e.season_id, s.number as season_number, e.number,
      coalesce(e.orig_season, s.number) as orig_season,
      coalesce(e.orig_number, e.number) as orig_number
    from episodes e
    join seasons s on s.id = e.season_id
    where s.item_id = ${itemId} and s.number > 0
    order by coalesce(e.absolute_number, 2147483647), s.number, e.number
  `);
  type Row = { id: number; season_id: number; season_number: number; number: number; orig_season: number; orig_number: number };
  return (res.rows as Row[]).map((r) => ({
    id: Number(r.id),
    seasonId: Number(r.season_id),
    seasonNumber: Number(r.season_number),
    number: Number(r.number),
    origSeason: Number(r.orig_season),
    origNumber: Number(r.orig_number),
  }));
}

/** Размер самого длинного сезона тайтла — порог «пора перестраивать». */
export async function longestSeason(db: Db, itemId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select coalesce(max(c), 0) as n from (
      select count(*)::int as c
      from episodes e join seasons s on s.id = e.season_id
      where s.item_id = ${itemId} and s.number > 0
      group by s.id
    ) t
  `);
  return Number(res.rows[0]?.n ?? 0);
}

export interface SeasonGroup {
  /** null — UI подпишет «Сезон N». */
  title: string | null;
  episodeIds: number[];
}

/**
 * Применяет раскладку: сезоны 1..N по группам, серии внутри — 1..k.
 * Серии, не попавшие ни в одну группу, дописываются в конец последней —
 * так ни одна серия не пропадает из меню.
 */
export async function applySeasonLayout(
  db: Db,
  itemId: number,
  layout: string,
  groups: SeasonGroup[],
): Promise<{ seasons: number; episodes: number }> {
  if (!groups.some((g) => g.episodeIds.length > 0)) return { seasons: 0, episodes: 0 };

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const flat = await flatEpisodes(tx, itemId);
    if (flat.length === 0) return { seasons: 0, episodes: 0 };
    const known = new Set(flat.map((e) => e.id));
    const used = new Set<number>();
    const plan = groups.map((g) => {
      const ids: number[] = [];
      for (const id of g.episodeIds) {
        if (known.has(id) && !used.has(id)) {
          used.add(id);
          ids.push(id);
        }
      }
      return { title: g.title, ids };
    }).filter((g) => g.ids.length > 0);
    if (plan.length === 0) return { seasons: 0, episodes: 0 };
    plan[plan.length - 1]!.ids.push(...flat.filter((e) => !used.has(e.id)).map((e) => e.id));

    // 1) Координаты источника и сквозной номер — запоминаем один раз.
    await tx.execute(sql`
      update episodes e set
        orig_season = coalesce(e.orig_season, s.number),
        orig_number = coalesce(e.orig_number, e.number)
      from seasons s
      where s.id = e.season_id and s.item_id = ${itemId} and s.number > 0
    `);
    await tx.execute(sql`
      update episodes e set absolute_number = coalesce(e.absolute_number, t.ord::int)
      from unnest(${intArray(flat.map((e) => e.id))}) with ordinality as t(id, ord)
      where e.id = t.id
    `);

    // 2) Номера в минус — уникальные (season, number) не мешают переносу.
    await tx.execute(sql`
      update episodes e set number = -e.id
      from seasons s
      where s.id = e.season_id and s.item_id = ${itemId} and s.number > 0
    `);
    const old = await tx.execute<{ id: number }>(sql`
      update seasons set number = -id
      where item_id = ${itemId} and number > 0
      returning id
    `);
    const reusable = (old.rows as Array<{ id: number }>).map((r) => Number(r.id)).sort((a, b) => a - b);

    // 3) Сезоны 1..N: старые id переиспользуем, недостающие создаём.
    let moved = 0;
    for (let i = 0; i < plan.length; i++) {
      const g = plan[i]!;
      let seasonId = reusable[i];
      if (seasonId != null) {
        await tx.execute(sql`
          update seasons set number = ${i + 1}, title = ${g.title} where id = ${seasonId}
        `);
      } else {
        const ins = await tx.execute<{ id: number }>(sql`
          insert into seasons (item_id, number, title) values (${itemId}, ${i + 1}, ${g.title})
          returning id
        `);
        seasonId = Number(ins.rows[0]!.id);
      }
      await tx.execute(sql`
        update episodes e set season_id = ${seasonId}, number = t.ord::int
        from unnest(${intArray(g.ids)}) with ordinality as t(id, ord)
        where e.id = t.id
      `);
      moved += g.ids.length;
    }

    // 4) Опустевшие старые сезоны — прочь (серий в них нет, каскад пуст).
    await tx.execute(sql`
      delete from seasons s
      where s.item_id = ${itemId} and s.number < 0
        and not exists (select 1 from episodes e where e.season_id = s.id)
    `);
    await tx.update(items).set({ seasonLayout: layout }).where(eq(items.id, itemId));
    return { seasons: plan.length, episodes: moved };
  });
}

/**
 * Серия по координатам источника: у перестроенного тайтла — по orig_*,
 * у обычного это тот же поиск по season/number.
 */
export async function findEpisodeByOrig(
  db: Db,
  itemId: number,
  seasonNumber: number,
  episodeNumber: number,
): Promise<number | null> {
  const res = await db.execute<{ id: number }>(sql`
    select e.id from episodes e join seasons s on s.id = e.season_id
    where s.item_id = ${itemId}
      and coalesce(e.orig_season, s.number) = ${seasonNumber}
      and coalesce(e.orig_number, e.number) = ${episodeNumber}
    limit 1
  `);
  return res.rows[0] ? Number(res.rows[0].id) : null;
}

/**
 * Новая серия перестроенного тайтла (ongoing): в конец последнего сезона,
 * с координатами источника — иначе её создали бы в «Сезоне 1» источника.
 */
export async function appendEpisodeToLastSeason(
  db: Db,
  itemId: number,
  orig: { seasonNumber: number; episodeNumber: number; title: string | null; runtime: number },
): Promise<number | null> {
  const res = await db.execute<{ id: number }>(sql`
    with last as (
      select s.id from seasons s where s.item_id = ${itemId} and s.number > 0
      order by s.number desc limit 1
    )
    insert into episodes (season_id, number, title, runtime, orig_season, orig_number, absolute_number)
    select last.id,
      coalesce((select max(number) from episodes where season_id = last.id), 0) + 1,
      ${orig.title}, ${orig.runtime}, ${orig.seasonNumber}, ${orig.episodeNumber},
      (select max(e.absolute_number) + 1 from episodes e join seasons s on s.id = e.season_id
        where s.item_id = ${itemId})
    from last
    returning id
  `);
  return res.rows[0] ? Number(res.rows[0].id) : null;
}

/** Раскладка тайтла (null — как у источника). */
export async function itemSeasonLayout(db: Db, itemId: number): Promise<string | null> {
  const [row] = await db
    .select({ layout: items.seasonLayout })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  return row?.layout ?? null;
}

/** Серия по сквозному номеру (заполнен у перестроенных и склеенных тайтлов). */
export async function findEpisodeByAbsolute(
  db: Db,
  itemId: number,
  absolute: number,
): Promise<number | null> {
  const res = await db.execute<{ id: number }>(sql`
    select e.id from episodes e join seasons s on s.id = e.season_id
    where s.item_id = ${itemId} and e.absolute_number = ${absolute}
    limit 1
  `);
  return res.rows[0] ? Number(res.rows[0].id) : null;
}
