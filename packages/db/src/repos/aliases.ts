/** Алиасы внешних релизов: (source, external_id) → (item, сезон). */
import { sql } from "drizzle-orm";
import type { Db } from "../db";

export interface ExternalAlias {
  itemId: number;
  seasonNumber: number;
}

export async function findExternalAlias(db: Db, source: string, externalId: string): Promise<ExternalAlias | null> {
  const res = await db.execute<{ item_id: number; season_number: number }>(sql`
    select item_id, season_number from item_external_aliases
    where source = ${source} and external_id = ${externalId}`);
  const r = (res.rows as Array<{ item_id: number; season_number: number }>)[0];
  return r ? { itemId: Number(r.item_id), seasonNumber: Number(r.season_number) } : null;
}

export async function recordExternalAlias(
  db: Db,
  source: string,
  externalId: string,
  itemId: number,
  seasonNumber: number,
): Promise<void> {
  await db.execute(sql`
    insert into item_external_aliases (source, external_id, item_id, season_number)
    values (${source}, ${externalId}, ${itemId}, ${seasonNumber})
    on conflict (source, external_id) do update set item_id = excluded.item_id, season_number = excluded.season_number`);
}
