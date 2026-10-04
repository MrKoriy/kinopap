import { authResponseSchema } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { makeOwnerWithInvite } from "./fixtures";
import { createTestApp } from "./setup";

async function ownerSession() {
  const { app, db } = await createTestApp();
  await makeOwnerWithInvite(db);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "owner@zal.local", password: "owner-password-1" },
  });
  expect(login.statusCode).toBe(200);
  return { app, tokens: authResponseSchema.parse(login.json()).tokens };
}

describe("POST /v1/auth/password", () => {
  it("меняет пароль владельца, отзывает старые сессии и выдаёт новую пару", async () => {
    const { app, tokens } = await ownerSession();

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { currentPassword: "owner-password-1", newPassword: "brand-new-secret-9" },
    });
    expect(res.statusCode).toBe(200);
    const fresh = authResponseSchema.parse(res.json()).tokens;
    expect(fresh.refreshToken).not.toBe(tokens.refreshToken);

    // Старый refresh отозван — остальные устройства выйдут.
    const oldRefresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(oldRefresh.statusCode).toBe(401);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "owner@zal.local", password: "owner-password-1" },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "owner@zal.local", password: "brand-new-secret-9" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("неверный текущий пароль — 400 wrong_password, пароль не меняется", async () => {
    const { app, tokens } = await ownerSession();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { currentPassword: "nope-nope-nope", newPassword: "brand-new-secret-9" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("wrong_password");

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "owner@zal.local", password: "owner-password-1" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("без токена — 401", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      payload: { currentPassword: "owner-password-1", newPassword: "brand-new-secret-9" },
    });
    expect(res.statusCode).toBe(401);
  });
});
