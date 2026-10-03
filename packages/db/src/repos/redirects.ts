/** Редиректы влитых карточек: /item/<from> → выжившая <to>. */
import { sql } from "drizzle-orm";
import type { Db } from "../db";

/** Записать склейку from → to (и перецепить старые редиректы на from). */
export async function recordItemRedirect(db: Db, fromId: number, toId: number): Promise<void> {
  if (fromId === toId) return;
  await db.execute(sql`update item_redirects set to_id = ${toId} where to_id = ${fromId}`);
  await db.execute(sql`
    insert into item_redirects (from_id, to_id) values (${fromId}, ${toId})
    on conflict (from_id) do update set to_id = excluded.to_id`);
}

/** Куда переехала удалённая карточка (null — не склеивалась). */
export async function resolveItemRedirect(db: Db, id: number): Promise<number | null> {
  const res = await db.execute<{ to_id: number }>(sql`select to_id from item_redirects where from_id = ${id}`);
  const row = (res.rows as Array<{ to_id: number }>)[0];
  return row ? Number(row.to_id) : null;
}
