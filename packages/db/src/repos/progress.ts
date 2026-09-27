/**
 * Прогресс просмотра (watch_progress): резюме с любого устройства.
 * Профиль — на будущее (переключение профилей в фазе 4), сейчас
 * используется дефолтный профиль пользователя.
 */

import type { WatchStatus } from "@zal/api-client";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { items, media, profiles, users, watchProgress } from "../schema/index";

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
  const name = user[0]?.name ?? "Profile";
  // onConflictDoNothing: два параллельных запроса (гонка unique по
  // userId+name) не валятся 500-й — проигравший перечитывает строку.
  const [created] = await db
    .insert(profiles)
    .values({ userId, name })
    .onConflictDoNothing({ target: [profiles.userId, profiles.name] })
    .returning();
  if (created) return created;

  const retry = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .orderBy(profiles.id)
    .limit(1);
  return retry[0]!;
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
  const now = new Date();

  // onConflictDoNothing: два устройства, пишущие позицию одновременно,
  // раньше устраивали гонку SELECT→INSERT и unique-нарушение → 500.
  const inserted = await db
    .insert(watchProgress)
    .values({
      profileId: input.profileId,
      itemId: input.itemId,
      mediaId: input.mediaId,
      positionSeconds: Math.round(input.positionSeconds),
      durationSeconds: Math.round(input.durationSeconds),
      status,
    })
    .onConflictDoNothing({
      target: [watchProgress.profileId, watchProgress.mediaId],
    })
    .returning();

  if (inserted[0]) {
    // Первый прогресс по media = состоявшийся просмотр (счётчик для «горячих»).
    await db
      .update(items)
      .set({ views: sql`${items.views} + 1` })
      .where(eq(items.id, input.itemId));
    return inserted[0];
  }

  const [row] = await db
    .update(watchProgress)
    .set({
      positionSeconds: Math.round(input.positionSeconds),
      durationSeconds: Math.round(input.durationSeconds),
      status,
      completedAt: status === "watched" ? now : undefined,
      updatedAt: now,
    })
    .where(
      and(eq(watchProgress.profileId, input.profileId), eq(watchProgress.mediaId, input.mediaId)),
    )
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
