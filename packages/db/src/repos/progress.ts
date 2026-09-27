/**
 * Прогресс просмотра (watch_progress): резюме с любого устройства.
 * Профиль — на будущее (переключение профилей в фазе 4), сейчас
 * используется дефолтный профиль пользователя.
 */
import { and, desc, eq } from "drizzle-orm";
import type { WatchStatus } from "@zal/api-client";
import type { Db } from "../db";
import { media, profiles, users, watchProgress } from "../schema/index";

export type ProgressRow = typeof watchProgress.$inferSelect;

/** Дефолтный профиль пользователя: первый по id, создаётся при первом запросе. */
export async function getDefaultProfile(db: Db, userId: number) {
  const existing = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .orderBy(profiles.id)
    .limit(1);
  if (existing[0]) return existing[0];

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const [row] = await db
    .insert(profiles)
    .values({ userId, name: user[0]?.name ?? "Profile" })
    .returning();
  return row!;
}

export async function getProgress(
  db: Db,
  profileId: number,
  mediaId: number,
): Promise<ProgressRow | null> {
  const rows = await db
    .select()
    .from(watchProgress)
    .where(
      and(eq(watchProgress.profileId, profileId), eq(watchProgress.mediaId, mediaId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertProgress(
  db: Db,
  input: {
    profileId: number;
    itemId: number;
    mediaId: number;
    positionSeconds: number;
    durationSeconds: number;
  },
): Promise<ProgressRow> {
  // Статус: watched при досмотре ≥ 95%, иначе in_progress.
  const ratio =
    input.durationSeconds > 0 ? input.positionSeconds / input.durationSeconds : 0;
  const status: WatchStatus = ratio >= 0.95 ? "watched" : "in_progress";

  const existing = await getProgress(db, input.profileId, input.mediaId);
  if (existing) {
    const [row] = await db
      .update(watchProgress)
      .set({
        positionSeconds: Math.round(input.positionSeconds),
        durationSeconds: Math.round(input.durationSeconds),
        status,
        completedAt: status === "watched" ? new Date() : existing.completedAt,
        updatedAt: new Date(),
      })
      .where(eq(watchProgress.id, existing.id))
      .returning();
    return row!;
  }

  const [row] = await db
    .insert(watchProgress)
    .values({
      profileId: input.profileId,
      itemId: input.itemId,
      mediaId: input.mediaId,
      positionSeconds: Math.round(input.positionSeconds),
      durationSeconds: Math.round(input.durationSeconds),
      status,
    })
    .returning();
  return row!;
}

/** Лента «продолжить просмотр»: свежие незавершённые. */
export async function listProgress(
  db: Db,
  profileId: number,
  limit = 20,
): Promise<ProgressRow[]> {
  return db
    .select()
    .from(watchProgress)
    .where(eq(watchProgress.profileId, profileId))
    .orderBy(desc(watchProgress.updatedAt))
    .limit(limit);
}

export { media as progressMediaTable };
