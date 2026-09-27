/**
 * Аккаунты: пользователи, инвайты, refresh-токены, профили.
 * Все записи — через drizzle, вход db общий (node-postgres / PGlite).
 */
import { randomInt } from "node:crypto";
import type { UserRole } from "@zal/api-client";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { invites, profiles, refreshTokens, users } from "../schema/index";

export type UserRow = typeof users.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;

/* ---------- Пользователи ---------- */

export async function createUser(
  db: Db,
  input: {
    email: string;
    passwordHash: string;
    name: string;
    role?: UserRole;
  },
): Promise<UserRow> {
  const rows = await db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      name: input.name,
      role: input.role ?? "member",
    })
    .returning();
  return rows[0]!;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(db: Db, id: number): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Компенсирующее удаление (например, при неудачном списании инвайта). */
export async function deleteUser(db: Db, id: number): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}

/* ---------- Refresh-токены ---------- */

export async function createRefreshToken(
  db: Db,
  input: {
    userId: number;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  },
): Promise<void> {
  await db.insert(refreshTokens).values({
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });
}

export async function findRefreshToken(db: Db, tokenHash: string) {
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Отзыв refresh-токена. false — уже был отозван (параллельный refresh). */
export async function revokeRefreshToken(db: Db, id: number): Promise<boolean> {
  const updated = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    // Guard от гонки: два параллельных refresh одним токеном раньше оба
    // проходили проверку revokedAt и создавали две живые цепочки.
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return updated.length > 0;
}

export async function revokeAllUserTokens(db: Db, userId: number): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.userId, userId));
}

/**
 * Удаление протухших токенов: истёкшие/отозванные старше keepDays.
 * Таблица раньше росла бесконечно — каждый логин это новая строка.
 */
export async function purgeStaleRefreshTokens(db: Db, keepDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(refreshTokens)
    .where(
      or(
        and(isNull(refreshTokens.revokedAt), sql`${refreshTokens.expiresAt} < now()`),
        sql`${refreshTokens.revokedAt} < ${cutoff}`,
      ),
    )
    .returning({ id: refreshTokens.id });
  return deleted.length;
}

/* ---------- Инвайты ---------- */

export function generateInviteCode(): string {
  // Буквы без похожих (O/0, I/1) — удобно кидать в чат.
  // CSPRNG: инвайт — единственный вход в закрытый клуб, Math.random не годится.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    code += alphabet[randomInt(alphabet.length)];
  }
  return code;
}

export async function createInvite(
  db: Db,
  input: {
    createdBy: number;
    maxUses?: number;
    expiresAt?: Date | null;
  },
): Promise<InviteRow> {
  const rows = await db
    .insert(invites)
    .values({
      code: generateInviteCode(),
      createdBy: input.createdBy,
      maxUses: input.maxUses ?? 1,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  return rows[0]!;
}

/**
 * Атомарное списание инвайта: +1 использованию, если лимит и срок позволяют.
 * true — код принят, false — невалиден/исперпан/протух.
 */
export async function consumeInvite(
  db: Db,
  code: string,
  userId: number,
): Promise<boolean> {
  const updated = await db
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1`, usedBy: userId })
    .where(
      and(
        eq(invites.code, code),
        sql`${invites.uses} < ${invites.maxUses}`,
        or(isNull(invites.expiresAt), sql`${invites.expiresAt} > now()`),
      ),
    )
    .returning({ id: invites.id });
  return updated.length > 0;
}

/** Список инвайтов (админ-панель): свежие первыми. */
export async function listInvites(db: Db): Promise<InviteRow[]> {
  return db.select().from(invites).orderBy(desc(invites.id)).limit(100);
}

/* ---------- Профили ---------- */

export async function createProfile(
  db: Db,
  input: { userId: number; name: string; isKids?: boolean },
): Promise<ProfileRow> {
  const rows = await db
    .insert(profiles)
    .values({
      userId: input.userId,
      name: input.name,
      isKids: input.isKids ?? false,
    })
    .returning();
  return rows[0]!;
}

export async function listProfilesByUser(db: Db, userId: number): Promise<ProfileRow[]> {
  return db.select().from(profiles).where(eq(profiles.userId, userId));
}
