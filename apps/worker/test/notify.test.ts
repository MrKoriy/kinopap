/**
 * Уведомления воркера: рассылка новых серий, привязка Telegram, алерты.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import {
  createTelegramLinkCode,
  createUser,
  type Db,
  getDefaultProfile,
  hashPassword,
  listNotifyChannels,
  migrationsDir,
  recordError,
  recordSyncRun,
  schema,
} from "@zal/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { episodeMessage, notifyNewEpisodes, opsAlerts, pollTelegram, type Senders } from "../src/notify";

let client: PGlite;
let db: Db;
let userId: number;
const cfg = { siteUrl: "https://zal.test" };

function fakeSenders() {
  return {
    telegram: vi.fn<Senders["telegram"]>().mockResolvedValue("ok"),
    webpush: vi.fn<Senders["webpush"]>().mockResolvedValue("ok"),
  };
}

beforeAll(async () => {
  client = new PGlite({ extensions: { pg_trgm } });
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: migrationsDir });
  db = d as unknown as Db;
  const user = await createUser(db, { email: "w@zal.local", passwordHash: await hashPassword("password-123"), name: "w" });
  userId = user.id;
  await db.update(schema.users).set({ role: "owner" });
});
afterAll(async () => {
  await client.close();
});

describe("telegram", () => {
  it("/start <code> привязывает чат, /stop отвязывает", async () => {
    const code = await createTelegramLinkCode(db, userId);
    const s = fakeSenders();
    const r = await pollTelegram(db, "t", s, async () => [
      { update_id: 10, message: { chat: { id: 42, username: "leo" }, text: `/start ${code}` } },
    ]);
    expect(r).toMatchObject({ linked: 1, cursor: "11" });
    expect(s.telegram).toHaveBeenCalledWith("42", expect.stringContaining("Готово"));
    expect((await listNotifyChannels(db, userId))[0]).toMatchObject({ kind: "telegram", label: "@leo" });
  });
});

describe("новые серии", () => {
  it("рассылает раз и помечает подписку", async () => {
    const profile = await getDefaultProfile(db, userId);
    const [item] = await db.insert(schema.items).values({ type: "serial", title: "Сериал" }).returning();
    const [season] = await db.insert(schema.seasons).values({ itemId: item!.id, number: 2 }).returning();
    const [ep] = await db.insert(schema.episodes).values({ seasonId: season!.id, number: 5 }).returning();
    const [m] = await db.insert(schema.media).values({ itemId: item!.id, episodeId: ep!.id }).returning();
    await db
      .insert(schema.subscriptions)
      .values({ profileId: profile.id, itemId: item!.id, notifiedAt: new Date(Date.now() - 3600_000) });

    const s = fakeSenders();
    expect(await notifyNewEpisodes(db, s, cfg)).toEqual({ subscriptions: 1, sent: 1 });
    expect(s.telegram).toHaveBeenCalledWith("42", expect.stringContaining("Сериал"), `https://zal.test/watch/${item!.id}/${m!.id}`);
    expect(await notifyNewEpisodes(db, s, cfg)).toEqual({ subscriptions: 0, sent: 0 });
  });

  it("текст: одна серия и пачка", () => {
    const base = { itemTitle: "X", season: 1, episode: 3, itemId: 1, mediaId: 2 };
    expect(episodeMessage({ ...base, count: 1 }, "https://z/").body).toBe("Вышла серия 3 (сезон 1)");
    expect(episodeMessage({ ...base, count: 4 }, "https://z").body).toContain("Новых серий: 4");
  });
});

describe("ops-alerts", () => {
  it("новая ошибка и застрявшая задача → алерт владельцу; повтор — тишина", async () => {
    await recordSyncRun(db, "tmdb-changes", { ok: true });
    const later = new Date(Date.now() + 4 * 3600_000);
    await recordError(db, { source: "api", message: "Error: boom" }, new Date(later.getTime() - 60_000));
    const s = fakeSenders();
    const r1 = await opsAlerts(db, s, cfg, later);
    expect(r1.stats).toMatchObject({ newErrors: 1, stale: ["tmdb-changes"], sent: 1 });
    expect(s.telegram.mock.calls[0]![1]).toContain("tmdb-changes");
    await recordSyncRun(db, "ops-alerts", { ok: true, cursor: r1.cursor, stats: r1.stats });
    const s2 = fakeSenders();
    const r2 = await opsAlerts(db, s2, cfg, new Date(later.getTime() + 60_000));
    expect(r2.stats.sent).toBe(0);
    expect(s2.telegram).not.toHaveBeenCalled();
  });
});
