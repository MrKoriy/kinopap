import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers";
import * as schema from "../src/schema/index";
import {
  consumeInvite,
  createInvite,
  createUser,
  findUserByEmail,
} from "../src/repos/accounts";
import { hashPassword, verifyPassword } from "../src/password";

describe("schema + migrations", () => {
  it("applies migrations and enables pg_trgm", async () => {
    const db = await createTestDb();
    const rows = await db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'pg_trgm'`,
    );
    expect(rows.rows.length).toBe(1);
  });

  it("similarity() works (trgm index backing)", async () => {
    const db = await createTestDb();
    const rows = await db.execute<{ s: number }>(
      sql`select similarity('матрица', 'матрица') as s`,
    );
    expect(Number(rows.rows[0]!.s)).toBe(1);
  });

  it("rejects duplicate user emails", async () => {
    const db = await createTestDb();
    const hash = await hashPassword("password12345");
    await createUser(db, { email: "a@zal.local", passwordHash: hash, name: "A" });
    await expect(
      createUser(db, { email: "a@zal.local", passwordHash: hash, name: "B" }),
    ).rejects.toThrow();
    const found = await findUserByEmail(db, "A@ZAL.LOCAL");
    expect(found?.name).toBe("A");
  });
});

describe("invites", () => {
  it("consumes within limits and refuses overuse", async () => {
    const db = await createTestDb();
    const hash = await hashPassword("password12345");
    const owner = await createUser(db, {
      email: "owner@zal.local",
      passwordHash: hash,
      name: "Owner",
    });
    const user = await createUser(db, {
      email: "u@zal.local",
      passwordHash: hash,
      name: "U",
    });
    const invite = await createInvite(db, { createdBy: owner.id, maxUses: 1 });

    expect(await consumeInvite(db, invite.code, user.id)).toBe(true);
    expect(await consumeInvite(db, invite.code, user.id)).toBe(false);
    expect(await consumeInvite(db, "NOPE", user.id)).toBe(false);
  });

  it("refuses expired invites", async () => {
    const db = await createTestDb();
    const hash = await hashPassword("password12345");
    const owner = await createUser(db, {
      email: "owner@zal.local",
      passwordHash: hash,
      name: "Owner",
    });
    const user = await createUser(db, {
      email: "u@zal.local",
      passwordHash: hash,
      name: "U",
    });
    const invite = await createInvite(db, {
      createdBy: owner.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await consumeInvite(db, invite.code, user.id)).toBe(false);
  });
});

describe("password hashing", () => {
  it("roundtrips and rejects wrong password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("hunter2hunter2", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("schema shape", () => {
  it("exports all planned tables", () => {
    for (const name of [
      "users",
      "refreshTokens",
      "invites",
      "profiles",
      "items",
      "seasons",
      "episodes",
      "media",
      "mediaFiles",
      "audioTracks",
      "subtitles",
      "genres",
      "countries",
      "people",
      "itemPeople",
      "watchProgress",
      "subscriptions",
      "votes",
      "comments",
      "lists",
      "listEntries",
    ]) {
      expect(schema[name as keyof typeof schema]).toBeDefined();
    }
  });
});
