/**
 * Discovery: спека fill-джобы и доступ к роутам.
 *
 * Сам fill в API-тестах не выполняется (в проде это фоновая джоба воркера,
 * здесь без Redis — синхронный путь упирается в отсутствие TMDB-ключа и
 * честно отвечает 403, без похода в сеть).
 */
import { users } from "@zal/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildFillSpec } from "../src/routes/discovery";
import { makeOwnerWithInvite } from "./fixtures";
import { createTestApp } from "./setup";

/**
 * Регистрирует пользователя с ролью и отдаёт access-токен (роль зашита в JWT,
 * поэтому роль проставляем до логина).
 */
async function tokenWithRole(
  app: Awaited<ReturnType<typeof createTestApp>>,
  role: "owner" | "admin" | "member",
): Promise<string> {
  const { invite } = await makeOwnerWithInvite(app.db);
  const email = `${role}-${Date.now()}@zal.local`;
  const reg = await app.app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { invite, email, password: "hunter2hunter2", name: email },
  });
  expect(reg.statusCode).toBe(201);
  await app.db.update(users).set({ role }).where(eq(users.email, email));
  const login = await app.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "hunter2hunter2" },
  });
  expect(login.statusCode).toBe(200);
  return (login.json().tokens as { accessToken: string }).accessToken;
}

describe("buildFillSpec", () => {
  it("годы включают всё: страницы, жанровую матрицу, списки, страны", () => {
    const spec = buildFillSpec({ years: [2000, 2001] });
    expect(spec.years).toEqual([2000, 2001]);
    expect(spec.yearPages).toBe(5);
    expect(spec.genreMatrix).toBe(true);
    expect(spec.genrePages).toBe(2);
    expect(spec.lists).toBe(true);
    expect(spec.countries?.length).toBeGreaterThan(0);
    expect(spec.minVotesMovie).toBeUndefined();
  });

  it("старый режим pages — только списки", () => {
    const spec = buildFillSpec({ pages: 5 });
    expect(spec.lists).toBe(true);
    expect(spec.years).toBeUndefined();
    expect(spec.genreMatrix).toBeUndefined();
  });

  it("только коллекции — не раздуваются до лет и стран", () => {
    const spec = buildFillSpec({ collections: ["Форсаж", "Миньоны"] });
    expect(spec.collections).toEqual(["Форсаж", "Миньоны"]);
    expect(spec.years).toBeUndefined();
    expect(spec.lists).toBeUndefined();
  });

  it("minVotes тянется и на сериалы (в 0.6 от кино)", () => {
    const spec = buildFillSpec({ years: [2001], minVotes: 50 });
    expect(spec.minVotesMovie).toBe(50);
    expect(spec.minVotesTv).toBe(30);
  });

  it("пустая спека — 400", () => {
    expect(() => buildFillSpec({})).toThrowError(/Укажи хотя бы один источник/);
  });
});

describe("GET/POST /v1/discover", () => {
  it("без токена — 401", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "POST", url: "/v1/discover", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("владелец без TMDB-ключа — 403 с внятным сообщением", async () => {
    const app = await createTestApp();
    const token = await tokenWithRole(app, "owner");
    const res = await app.app.inject({
      method: "POST",
      url: "/v1/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: { years: [2001] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("TMDB_API_KEY");
  });

  it("member не может запускать fill — 403", async () => {
    const app = await createTestApp();
    const token = await tokenWithRole(app, "member");
    const res = await app.app.inject({
      method: "POST",
      url: "/v1/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: { years: [2001] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("owner/admin");
  });

  it("статус без очереди — 404 для неизвестной задачи", async () => {
    const app = await createTestApp();
    const token = await tokenWithRole(app, "owner");
    const res = await app.app.inject({
      method: "GET",
      url: "/v1/discover/status?job=nope",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
