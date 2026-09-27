/** Статистика просмотров: первый прогресс по media увеличивает items.views. */
import { describe, expect, it } from "vitest";
import { createTestDb, seedFixtures, type TestDb } from "./helpers";
import {
  createUser,
  getDefaultProfile,
  hashPassword,
  upsertProgress,
} from "../src/index";

async function makeProfile(db: TestDb, email: string) {
  const user = await createUser(db, {
    email,
    passwordHash: await hashPassword("password-123"),
    name: email.split("@")[0]!,
  });
  return getDefaultProfile(db, user.id);
}

async function viewsOf(db: TestDb, itemId: number): Promise<number> {
  const rows = await db.query.items.findMany({ where: (i, { eq }) => eq(i.id, itemId) });
  return rows[0]!.views;
}

describe("просмотры (views)", () => {
  it("первый прогресс по media считается просмотром, обновления — нет", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const profile = await makeProfile(db, "watcher@zal.local");
    const matrixMedia = (
      await db.query.media.findMany({
        where: (m, { eq }) => eq(m.itemId, f.matrix),
      })
    )[0]!;
    const before = await viewsOf(db, f.matrix);

    // Первое сохранение позиции — просмотр.
    await upsertProgress(db, {
      profileId: profile.id,
      itemId: f.matrix,
      mediaId: matrixMedia.id,
      positionSeconds: 10,
      durationSeconds: 136,
    });
    expect(await viewsOf(db, f.matrix)).toBe(before + 1);

    // Повторные обновления той же media счётчик не крутят.
    await upsertProgress(db, {
      profileId: profile.id,
      itemId: f.matrix,
      mediaId: matrixMedia.id,
      positionSeconds: 20,
      durationSeconds: 136,
    });
    await upsertProgress(db, {
      profileId: profile.id,
      itemId: f.matrix,
      mediaId: matrixMedia.id,
      positionSeconds: 40,
      durationSeconds: 136,
    });
    expect(await viewsOf(db, f.matrix)).toBe(before + 1);

    // Другой профиль — своя сессия просмотра у тайтла.
    const second = await makeProfile(db, "watcher2@zal.local");
    const ep1 = (
      await db.query.media.findMany({
        where: (m, { eq, and, isNotNull }) =>
          and(eq(m.itemId, f.got), isNotNull(m.episodeId)),
      })
    ).sort((a, b) => a.id - b.id)[0]!;
    const gotBefore = await viewsOf(db, f.got);
    await upsertProgress(db, {
      profileId: second.id,
      itemId: f.got,
      mediaId: ep1.id,
      positionSeconds: 30,
      durationSeconds: 62,
    });
    expect(await viewsOf(db, f.got)).toBe(gotBefore + 1);
  });
});
