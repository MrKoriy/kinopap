/**
 * «Рекомендуем вам»: контентная похожесть на то, что профиль смотрел,
 * добавлял в избранное и лайкал. Жанры (вес по доле в истории) + люди
 * (режиссёры и первые актёры титров) + немного рейтинга и популярности.
 * Просмотренное, начатое, избранное и дизлайкнутое в выдачу не попадает.
 * Холодный старт (истории нет) — пустой список: клиент ленту не рисует.
 */

import type { ItemSummary } from "@zal/api-client";
import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { getItemsByIds } from "./catalog";

/** Сколько последних сигналов истории учитываем: вкусы меняются. */
const SEED_CAP = 60;

export async function recommendItems(db: Db, profileId: number, limit = 20): Promise<ItemSummary[]> {
  const res = await db.execute<{ id: number }>(sql`
    with signals as (
      select item_id, 3 as w, created_at as at from favorites where profile_id = ${profileId}
      union all
      select item_id, case when positive then 3 else -100 end, updated_at from votes where profile_id = ${profileId}
      union all
      select item_id, case when bool_or(status = 'watched') then 2 else 1 end, max(updated_at)
      from watch_progress where profile_id = ${profileId} group by item_id
    ),
    seeds as (select item_id, sum(w) as w, max(at) as at from signals group by item_id),
    pos as (select item_id, w from seeds where w > 0 order by at desc limit ${SEED_CAP}),
    g as (
      select ig.genre_id, sum(pos.w)::float as w from item_genres ig join pos using (item_id) group by 1
    ),
    gt as (select nullif(sum(w), 0) as t from g),
    p as (
      select ip.person_id, sum(pos.w)::float as w
      from item_people ip join pos using (item_id)
      where ip.role = 'director' or (ip.role = 'actor' and ip.ord < 6)
      group by 1
    ),
    cand as (
      select ig.item_id, sum(g.w) / (select t from gt) as gs
      from item_genres ig join g using (genre_id)
      group by 1
    ),
    pc as (
      select ip.item_id, sum(p.w) as ps
      from item_people ip join p using (person_id)
      where ip.role = 'director' or (ip.role = 'actor' and ip.ord < 6)
      group by 1
    )
    select i.id
    from cand c
    join items i on i.id = c.item_id
    left join pc on pc.item_id = c.item_id
    where not exists (select 1 from seeds s where s.item_id = i.id)
      and (i.rating >= 6 or i.views > 0)
    order by c.gs * 2 + least(coalesce(pc.ps, 0), 6) * 0.4 + i.rating / 10 + ln(1 + i.views) / 15 desc, i.id
    limit ${limit}
  `);
  const ids = (res.rows as Array<{ id: number }>).map((r) => Number(r.id));
  return getItemsByIds(db, ids);
}
