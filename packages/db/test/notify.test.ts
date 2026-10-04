/**
 * Уведомления: привязка Telegram кодом, выборка новых серий по подпискам
 * (только вышедшие, только после прошлой рассылки), лента ошибок.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  consumeTelegramLinkCode,
  createTelegramLinkCode,
  createUser,
  errorFingerprint,
  getDefaultProfile,
  hashPassword,
  listNotifyChannels,
  listPendingEpisodeNotices,
  listRecentErrors,
  markSubscriptionsNotified,
  recordError,
  schema,
} from "../src/index";
import { createTestDb, type FixtureIds, seedFixtures, type TestDb } from "./helpers";

let db: TestDb;
let f: FixtureIds;
let userId: number;
let profileId: number;

beforeAll(async () => {
  db = await createTestDb();
  f = await seedFixtures(db);
  const user = await createUser(db, { email: "n@zal.local", passwordHash: await hashPassword("password-123"), name: "n" });
  userId = user.id;
  profileId = (await getDefaultProfile(db, user.id)).id;
});

describe("notify", () => {
  it("код привязки одноразовый и протухает", async () => {
    const code = await createTelegramLinkCode(db, userId);
    expect(await consumeTelegramLinkCode(db, code, "555", "@leo")).toBe(userId);
    expect(await consumeTelegramLinkCode(db, code, "555", "@leo")).toBeNull();
    const late = await createTelegramLinkCode(db, userId, new Date(Date.now() - 60 * 60 * 1000));
    expect(await consumeTelegramLinkCode(db, late, "556", null)).toBeNull();
    const channels = await listNotifyChannels(db, userId);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ kind: "telegram", label: "@leo" });
  });

  it("новые серии после notified_at, будущие — нет", async () => {
    const past = new Date(Date.now() - 24 * 3600_000);
    const [sub] = await db
      .insert(schema.subscriptions)
      .values({ profileId, itemId: f.got, notify: true, notifiedAt: past })
      .returning();
    const pending = await listPendingEpisodeNotices(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ itemId: f.got, userId, season: 1, episode: 1 });

    await markSubscriptionsNotified(db, [sub!.id]);
    expect(await listPendingEpisodeNotices(db)).toHaveLength(0);
  });

  it("ошибки склеиваются по отпечатку", async () => {
    await recordError(db, { source: "web", message: "Cannot read id of undefined at item 42", page: "/item/42" });
    await recordError(db, { source: "web", message: "Cannot read id of undefined at item 77", page: "/item/77" });
    const list = await listRecentErrors(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ count: 2, page: "/item/77" });
    expect(errorFingerprint({ source: "api", message: "x 1", stack: null })).toBe(
      errorFingerprint({ source: "api", message: "x 2", stack: null }),
    );
  });
});
