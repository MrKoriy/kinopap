/**
 * Аккаунты: пользователи, инвайты, refresh-токены, профили.
 * Все записи — через drizzle, вход db общий (node-postgres / PGlite).
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { invites, profiles, refreshTokens, users } from "../schema/index";
import type { UserRole } from "@zal/api-client";

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

export async function revokeRefreshToken(db: Db, id: number): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.id, id));
}

export async function revokeAllUserTokens(db: Db, userId: number): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.userId, userId));
}

/* ---------- Инвайты ---------- */

export function generateInviteCode(): string {
  // Буквы без похожих (O/0, I/1) — удобно кидать в чат.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
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
 * true — код принят, false — невалиден/исчерпан/протух.
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
