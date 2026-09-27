import { progressListResponseSchema, progressResponseSchema } from "@zal/api-client";
import { users } from "@zal/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeFixtures, makeOwnerWithInvite } from "./fixtures";
import { createTestApp } from "./setup";

async function registerUser(
  app: Awaited<ReturnType<typeof createTestApp>>,
  email: string,
): Promise<string> {
  const { invite } = await makeOwnerWithInvite(app.db);
  const reg = await app.app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { invite, email, password: "hunter2hunter2", name: email },
  });
  expect(reg.statusCode).toBe(201);
  await app.db.update(users).set({ role: "owner" }).where(eq(users.email, email));
  const login = await app.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "hunter2hunter2" },
  });
  return (login.json().tokens as { accessToken: string }).accessToken;
}

describe("progress routes", () => {
  it("сохраняет позицию, резюме и ленту «продолжить»", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "viewer@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    // Нет прогресса → null.
    const empty = await app.app.inject({
      method: "GET",
      url: `/v1/progress/${ids.movieMedia}`,
      headers: auth,
    });
    expect(progressResponseSchema.parse(empty.json()).progress).toBeNull();

    // Сохраняем середину.
    const saved = await app.app.inject({
      method: "PUT",
      url: `/v1/progress/${ids.movieMedia}`,
      headers: auth,
      payload: { positionSeconds: 68, durationSeconds: 136 },
    });
    expect(saved.statusCode).toBe(200);
    const dto = progressResponseSchema.parse(saved.json()).progress!;
    expect(dto).toMatchObject({
      mediaId: ids.movieMedia,
      itemId: ids.movie,
      positionSeconds: 68,
      status: "in_progress",
    });

    // Резюме доступно повторно.
    const reread = await app.app.inject({
      method: "GET",
      url: `/v1/progress/${ids.movieMedia}`,
      headers: auth,
    });
    expect(progressResponseSchema.parse(reread.json()).progress?.positionSeconds).toBe(68);

    // Досмотр ≥95% → watched.
    const done = await app.app.inject({
      method: "PUT",
      url: `/v1/progress/${ids.movieMedia}`,
      headers: auth,
      payload: { positionSeconds: 135, durationSeconds: 136 },
    });
    expect(progressResponseSchema.parse(done.json()).progress?.status).toBe("watched");

    // Лента «продолжить».
    const list = await app.app.inject({ method: "GET", url: "/v1/progress", headers: auth });
    const items = progressListResponseSchema.parse(list.json()).items;
    expect(items.map((i) => i.mediaId)).toContain(ids.movieMedia);
  });

  it("404 на неизвестном media, 401 без токена", async () => {
    const app = await createTestApp();
    const token = await registerUser(app, "viewer2@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    const missing = await app.app.inject({
      method: "PUT",
      url: "/v1/progress/99999",
      headers: auth,
      payload: { positionSeconds: 1, durationSeconds: 2 },
    });
    expect(missing.statusCode).toBe(404);

    const unauth = await app.app.inject({
      method: "GET",
      url: "/v1/progress/1",
    });
    expect(unauth.statusCode).toBe(401);

    // Кривое тело.
    const bad = await app.app.inject({
      method: "PUT",
      url: "/v1/progress/1",
      headers: auth,
      payload: { positionSeconds: -5 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
