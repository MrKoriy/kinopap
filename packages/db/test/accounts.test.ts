import { describe, expect, it } from "vitest";
import {
  createInvite,
  createUser,
  type Db,
  findUserByEmail,
  registerUserWithInvite,
} from "../src";
import { createTestDb } from "./helpers";

describe("registerUserWithInvite", () => {
  it("создаёт пользователя и списывает инвайт одной транзакцией", async () => {
    const db = await createTestDb();
    const owner = await createUser(db, {
      email: "owner@zal.local",
      passwordHash: "scrypt$salt$hash",
      name: "Owner",
    });
    const invite = await createInvite(db, { createdBy: owner.id, maxUses: 1 });

    const res = await registerUserWithInvite(db, {
      email: "fan@zal.local",
      passwordHash: "scrypt$salt$hash",
      name: "fan",
      inviteCode: invite.code,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.user.email).toBe("fan@zal.local");
    expect(res.profileId).toBeGreaterThan(0);

    const stored = await findUserByEmail(db, "fan@zal.local");
    expect(stored?.name).toBe("fan");
  });

  it("занятый email → email_taken, невалидный инвайт → invalid_invite", async () => {
    const db = await createTestDb();
    const owner = await createUser(db, {
      email: "owner@zal.local",
      passwordHash: "scrypt$salt$hash",
      name: "Owner",
    });
    const invite = await createInvite(db, { createdBy: owner.id, maxUses: 5 });
    const another = await createInvite(db, { createdBy: owner.id });

    const reg = await registerUserWithInvite(db, {
      email: "fan@zal.local",
      passwordHash: "scrypt$salt$hash",
      name: "fan",
      inviteCode: invite.code,
    });
    expect(reg.ok).toBe(true);

    const dup = await registerUserWithInvite(db, {
      email: "fan@zal.local",
      passwordHash: "scrypt$salt$hash",
      name: "fan2",
      inviteCode: another.code,
    });
    expect(dup).toEqual({ ok: false, reason: "email_taken" });

    const badInvite = await registerUserWithInvite(db, {
      email: "other@zal.local",
      passwordHash: "scrypt$salt$hash",
      name: "other",
      inviteCode: "NOPE",
    });
    expect(badInvite).toEqual({ ok: false, reason: "invalid_invite" });
  });

  it("обёрнутая drizzle-ошибка (код 23505 в cause) маппится в email_taken", async () => {
    // Гонка email: ранний findUserByEmail пропустил, insert упёрся в
    // unique. drizzle 0.45 кладёт PG-код в cause DrizzleQueryError —
    // раньше catch смотрел только err.code и пропускал её.
    const cause = new Error(
      'duplicate key value violates unique constraint "users_email_key"',
    );
    (cause as { code?: string }).code = "23505";
    const wrapped = new Error('Failed query: insert into "users" ...');
    (wrapped as { cause?: unknown }).cause = cause;
    const db = {
      transaction: async () => {
        throw wrapped;
      },
    } as unknown as Db;

    const res = await registerUserWithInvite(db, {
      email: "race@zal.local",
      passwordHash: "scrypt$salt$hash",
      name: "race",
      inviteCode: "ANY",
    });
    expect(res).toEqual({ ok: false, reason: "email_taken" });
  });
});
