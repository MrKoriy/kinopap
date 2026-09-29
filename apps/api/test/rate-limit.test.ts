import { describe, expect, it } from "vitest";
import { makeFixtures, makeOwnerWithInvite } from "./fixtures";
import { createTestApp } from "./setup";

/** Лимит логина 15/мин срабатывает в onRequest — до проверки пароля,
 * поэтому достаточно валидного по формату тела с несуществующим email. */
const creds = { email: "nobody@zal.local", password: "wrong-password" };

describe("rate limit (429)", () => {
  it("16-й логин подряд — 429 rate_limited, а не bad_request", async () => {
    const { app } = await createTestApp();

    for (let i = 0; i < 15; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: creds,
      });
      expect(res.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: creds,
    });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    // Строгий единый формат: ровно { error: { code, message } }.
    expect(body).toEqual({
      error: { code: "rate_limited", message: expect.any(String) },
    });
    // Message плагина дошёл до клиента, а не фолбэк общей 4xx-ветки.
    expect(body.error.message).not.toBe("Malformed request");
    expect(body.error.message).toMatch(/rate limit/i);
    // retry-after ставит сам плагин — проверяем, что он на месте.
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("store в памяти инстанса: новое приложение — счётчик с нуля", async () => {
    const first = await createTestApp();
    for (let i = 0; i < 16; i++) {
      await first.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: creds,
      });
    }

    const second = await createTestApp();
    const res = await second.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: creds,
    });
    expect(res.statusCode).toBe(401);
  });

  it("31-й комментарий подряд — 429 rate_limited (лимит 30/мин)", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const { invite } = await makeOwnerWithInvite(app.db);
    const reg = await app.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        invite,
        email: "comment-spam@zal.local",
        password: "hunter2hunter2",
        name: "Spam",
      },
    });
    expect(reg.statusCode).toBe(201);
    const auth = {
      authorization: `Bearer ${(reg.json().tokens as { accessToken: string }).accessToken}`,
    };

    for (let i = 0; i < 30; i++) {
      const res = await app.app.inject({
        method: "POST",
        url: `/v1/items/${ids.movie}/comments`,
        headers: auth,
        payload: { body: `комментарий №${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    const limited = await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      headers: auth,
      payload: { body: "тридцать первый подряд" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: { code: "rate_limited", message: expect.any(String) },
    });
  });
});
