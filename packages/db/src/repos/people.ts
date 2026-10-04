/**
 * Актёры и команда: люди дедуплицируются по TMDb-id, у тайтла — свежий
 * снимок титров (старые строки item_people заменяются целиком: состав
 * сериала меняется от сезона к сезону, дописывать — копить мусор).
 */
import type { PersonCredit, PersonRole } from "@zal/api-client";
import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { itemPeople, items, people } from "../schema/index";

export interface CreditInput {
  tmdbId: number;
  name: string;
  photoUrl: string | null;
  role: PersonRole;
  character: string | null;
  ord: number;
}

/** Повторная проверка титров: состав онгоингов дополняется. */
const CREDITS_RETRY_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Записывает титры тайтла и бэкдроп; credits_checked_at = now. Пустой список
 * — тоже результат: тайтл помечен и выпадает из бэкфилла на 60 дней.
 */
export async function replaceItemCredits(
  db: Db,
  itemId: number,
  credits: CreditInput[],
  extra: { backdropUrl?: string | null } = {},
): Promise<number> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const byTmdb = new Map<number, CreditInput>();
    for (const c of credits) if (!byTmdb.has(c.tmdbId)) byTmdb.set(c.tmdbId, c);
    const personIds = new Map<number, number>();
    if (byTmdb.size > 0) {
      const rows = await tx
        .insert(people)
        .values([...byTmdb.values()].map((c) => ({ tmdbId: c.tmdbId, name: c.name, nameEn: c.name, photoUrl: c.photoUrl })))
        .onConflictDoUpdate({
          target: people.tmdbId,
          targetWhere: sql`tmdb_id IS NOT NULL`,
          set: { name: sql`excluded.name`, photoUrl: sql`coalesce(excluded.photo_url, ${people.photoUrl})` },
        })
        .returning({ id: people.id, tmdbId: people.tmdbId });
      for (const r of rows) if (r.tmdbId != null) personIds.set(r.tmdbId, r.id);
    }
    await tx.delete(itemPeople).where(eq(itemPeople.itemId, itemId));
    const seen = new Set<string>();
    const values = credits
      .map((c) => ({ c, personId: personIds.get(c.tmdbId) }))
      .filter((x): x is { c: CreditInput; personId: number } => x.personId != null)
      .filter(({ c, personId }) => {
        const k = `${personId}:${c.role}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(({ c, personId }) => ({ itemId, personId, role: c.role, characterName: c.character, ord: c.ord }));
    if (values.length > 0) await tx.insert(itemPeople).values(values);
    const patch: Partial<typeof items.$inferInsert> = { creditsCheckedAt: new Date() };
    if (extra.backdropUrl !== undefined && extra.backdropUrl !== null) patch.backdropUrl = extra.backdropUrl;
    await tx.update(items).set(patch).where(eq(items.id, itemId));
    return values.length;
  });
}

/** Отметить «титры проверены» без записи (TMDb ответил 404 и т.п.). */
export async function markCreditsChecked(db: Db, itemId: number): Promise<void> {
  await db.update(items).set({ creditsCheckedAt: new Date() }).where(eq(items.id, itemId));
}

export interface CreditsBackfillRow {
  id: number;
  type: string;
  title: string;
  tmdbId: number;
  tmdbType: string | null;
}

const missingCredits = () =>
  and(
    isNotNull(items.tmdbId),
    or(isNull(items.creditsCheckedAt), lt(items.creditsCheckedAt, new Date(Date.now() - CREDITS_RETRY_MS))),
  );

/** Очередь бэкфилла титров: курсор по id, как у трейлеров. */
export async function listItemsMissingCredits(
  db: Db,
  opts: { limit?: number; afterId?: number } = {},
): Promise<CreditsBackfillRow[]> {
  const rows = await db
    .select({ id: items.id, type: items.type, title: items.title, tmdbId: items.tmdbId, tmdbType: items.tmdbType })
    .from(items)
    .where(and(missingCredits(), gt(items.id, opts.afterId ?? 0)))
    .orderBy(items.id)
    .limit(opts.limit ?? 200);
  return rows as CreditsBackfillRow[];
}

export async function countItemsMissingCredits(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(items).where(missingCredits());
  return rows[0]?.n ?? 0;
}

/** Топ-N актёров + команда тайтла в порядке титров. */
export async function getItemCredits(
  db: Db,
  itemId: number,
  opts: { castLimit?: number } = {},
): Promise<{ cast: PersonCredit[]; crew: PersonCredit[] }> {
  const rows = await db
    .select({
      id: people.id,
      name: people.name,
      photoUrl: people.photoUrl,
      role: itemPeople.role,
      character: itemPeople.characterName,
      ord: itemPeople.ord,
    })
    .from(itemPeople)
    .innerJoin(people, eq(itemPeople.personId, people.id))
    .where(eq(itemPeople.itemId, itemId))
    .orderBy(asc(itemPeople.ord), asc(people.id));
  const castLimit = opts.castLimit ?? 20;
  const cast = rows.filter((r) => r.role === "actor" || r.role === "voice").slice(0, castLimit);
  const crewOrder: PersonRole[] = ["director", "writer", "producer", "composer"];
  const crew = rows
    .filter((r) => r.role !== "actor" && r.role !== "voice")
    .sort((a, b) => crewOrder.indexOf(a.role) - crewOrder.indexOf(b.role) || a.ord - b.ord);
  const map = (r: (typeof rows)[number]): PersonCredit => ({
    id: r.id,
    name: r.name,
    photoUrl: r.photoUrl,
    role: r.role,
    character: r.character,
  });
  return { cast: cast.map(map), crew: crew.map(map) };
}
