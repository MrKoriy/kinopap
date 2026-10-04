/**
 * «Рекомендуем вам»: похожее по жанрам и людям на историю профиля,
 * без уже виденного и дизлайкнутого.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, getDefaultProfile, hashPassword, recommendItems, schema } from "../src/index";
import { createTestDb, type FixtureIds, seedFixtures, type TestDb } from "./helpers";

let db: TestDb;
let f: FixtureIds;

async function makeProfile(email: string) {
  const user = await createUser(db, { email, passwordHash: await hashPassword("password-123"), name: "u" });
  return getDefaultProfile(db, user.id);
}

beforeAll(async () => {
  db = await createTestDb();
  f = await seedFixtures(db);
});

describe("recommendItems", () => {
  it("без истории — пусто", async () => {
    const p = await makeProfile("cold@zal.local");
    expect(await recommendItems(db, p.id)).toEqual([]);
  });

  it("лайк «Матрицы» → «Перезагрузка» первой, сама «Матрица» не предлагается", async () => {
    const p = await makeProfile("fan@zal.local");
    await db.insert(schema.votes).values({ profileId: p.id, itemId: f.matrix, positive: true });
    const recs = await recommendItems(db, p.id);
    expect(recs[0]?.id).toBe(f.reloaded);
    expect(recs.map((r) => r.id)).not.toContain(f.matrix);
  });

  it("дизлайкнутое исключено", async () => {
    const p = await makeProfile("hater@zal.local");
    await db.insert(schema.favorites).values({ profileId: p.id, itemId: f.matrix });
    await db.insert(schema.votes).values({ profileId: p.id, itemId: f.reloaded, positive: false });
    const ids = (await recommendItems(db, p.id)).map((r) => r.id);
    expect(ids).not.toContain(f.reloaded);
    expect(ids).not.toContain(f.matrix);
  });
});
