import { authResponseSchema, meResponseSchema } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { makeOwnerWithInvite } from "./fixtures";
import { createTestApp } from "./setup";

describe("auth", () => {
  it("registers with invite, returns tokens, me works", async () => {
    const { app, db } = await createTestApp();
    const { invite } = await makeOwnerWithInvite(db);

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        invite,
        email: "user@zal.local",
        password: "hunter2hunter2",
        name: "Larp",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = authResponseSchema.parse(res.json());
    expect(body.user.email).toBe("user@zal.local");
    expect(body.tokens.accessToken.length).toBeGreaterThan(20);
    expect(body.tokens.refreshToken.length).toBeGreaterThan(20);

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(meResponseSchema.parse(me.json()).user.name).toBe("Larp");
  });

  it("rejects bad invite and does not create the user", async () => {
    const { app } = await createTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        invite: "WRONGCODE123",
        email: "ghost@zal.local",
        password: "hunter2hunter2",
        name: "Ghost",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_invite");

    // Пользователь откатился — логин не работает.
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "ghost@zal.local", password: "hunter2hunter2" },
    });
    expect(login.statusCode).toBe(401);
  });

  it("rejects duplicate email with 409", async () => {
    const { app, db } = await createTestApp();
    const payload = (invite: string) => ({
      invite,
      email: "dup@zal.local",
      password: "hunter2hunter2",
      name: "Dup",
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: payload((await makeOwnerWithInvite(db)).invite),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: payload((await makeOwnerWithInvite(db)).invite),
    });
    expect(second.statusCode).toBe(409);
  });

  it("logs in and rejects wrong password", async () => {
    const { app, db } = await createTestApp();
    const { invite } = await makeOwnerWithInvite(db);
    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        invite,
        email: "user@zal.local",
        password: "hunter2hunter2",
        name: "Larp",
      },
    });

    const ok = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "user@zal.local", password: "hunter2hunter2" },
    });
    expect(ok.statusCode).toBe(200);
    expect(authResponseSchema.parse(ok.json()).user.email).toBe("user@zal.local");

    for (const bad of [
      { email: "user@zal.local", password: "wrong" },
      { email: "nobody@zal.local", password: "hunter2hunter2" },
    ]) {
      const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: bad });
      expect(res.statusCode).toBe(401);
    }
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const { app, db } = await createTestApp();
    const { invite } = await makeOwnerWithInvite(db);
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        invite,
        email: "user@zal.local",
        password: "hunter2hunter2",
        name: "Larp",
      },
    });
    const { tokens } = authResponseSchema.parse(reg.json());

    // Ротация: старый отзывается, новый работает.
    const rotated = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json().tokens;

    // Повторное использование старого токена → 401 и гашение всех сессий.
    const reuse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.message).toMatch(/reuse/i);

    const afterReuse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: next.refreshToken },
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const { app, db } = await createTestApp();
    const { invite } = await makeOwnerWithInvite(db);
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        invite,
        email: "user@zal.local",
        password: "hunter2hunter2",
        name: "Larp",
      },
    });
    const { tokens } = authResponseSchema.parse(reg.json());

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(logout.statusCode).toBe(200);

    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it("protects /me without a token", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });
});

describe("invites (owner/admin)", () => {
  it("owner создаёт инвайт и видит список; member — 403", async () => {
    const { app, db } = await createTestApp();
    const { invite } = await makeOwnerWithInvite(db);

    // Логин owner'ом.
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "owner@zal.local", password: "owner-password-1" },
    });
    const { tokens } = login.json();

    const created = await app.inject({
      method: "POST",
      url: "/v1/invites",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { maxUses: 3, expiresInDays: 7 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json().invite;
    expect(body.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
    expect(body.maxUses).toBe(3);
    expect(body.expiresAt).toBeTruthy();

    const list = await app.inject({
      method: "GET",
      url: "/v1/invites",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const codes = list.json().invites.map((i: { code: string }) => i.code);
    expect(codes).toContain(body.code);
    expect(codes).toContain(invite);

    // Зарегистрируем member'а и проверим 403.
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        invite,
        email: "member@zal.local",
        password: "hunter2hunter2",
        name: "Member",
      },
    });
    const memberTokens = reg.json().tokens;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/invites",
      headers: { authorization: `Bearer ${memberTokens.accessToken}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("refresh через httpOnly-cookie (веб)", () => {
  it("логин ставит куку, refresh по ней ротирует и переписывает её", async () => {
    const { app, db } = await createTestApp();
    const { invite } = await makeOwnerWithInvite(db);

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "owner@zal.local", password: "owner-password-1" },
    });
    expect(login.statusCode).toBe(200);

    // Кука выдана, httpOnly, узкий path.
    const setCookie = login.cookies.find((c) => c.name === "zal_rt");
    expect(setCookie).toBeTruthy();
    expect(setCookie?.httpOnly).toBe(true);
    expect(setCookie?.path).toBe("/v1/auth");

    // Ротация по куке, без тела.
    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      cookies: { zal_rt: setCookie!.value },
    });
    expect(refresh.statusCode).toBe(200);
    const refreshed = refresh.cookies.find((c) => c.name === "zal_rt");
    expect(refreshed?.value).not.toBe(setCookie!.value);

    // Старая кука отозвана: reuse → 401 и все токены погашены.
    const reuse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      cookies: { zal_rt: setCookie!.value },
    });
    expect(reuse.statusCode).toBe(401);

    // Logout по актуальной куке отзывает её.
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      cookies: { zal_rt: refreshed!.value },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.cookies.find((c) => c.name === "zal_rt")?.value).toBe("");
  });
});
