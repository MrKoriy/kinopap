import {
  favoriteListResponseSchema,
  favoriteResponseSchema,
  historyListResponseSchema,
  itemProgressResponseSchema,
  profileOverviewResponseSchema,
  userListDetailResponseSchema,
  userListListResponseSchema,
  userListResponseSchema,
} from "@zal/api-client";
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

describe("profile: сохранённое", () => {
  it("токен без pid (выдан до pid в payload) дорезолвит профиль из БД", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    // Живой токен с pid — работает.
    const token = await registerUser(app, "pid-ok@zal.local");
    const auth = { authorization: `Bearer ${token}` };
    const added = await app.app.inject({
      method: "PUT",
      url: `/v1/favorites/${ids.movie}`,
      headers: auth,
    });
    expect(added.statusCode).toBe(200);

    // Ручная подпись без pid: старые токены не должны ломать роуты.
    const [user] = await app.db.select().from(users).where(eq(users.email, "pid-ok@zal.local"));
    const legacy = app.app.jwt.sign({
      sub: user!.id,
      role: "member",
      typ: "access",
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/v1/favorites",
      headers: { authorization: `Bearer ${legacy}` },
    });
    expect(res.statusCode).toBe(200);
    const dto = favoriteListResponseSchema.parse(res.json());
    expect(dto.items.length).toBe(1);
  });

  it("добавляет, идемпотентно повторяет и убирает закладку", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "fav@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    const added = await app.app.inject({
      method: "PUT",
      url: `/v1/favorites/${ids.movie}`,
      headers: auth,
    });
    expect(added.statusCode).toBe(200);
    const dto = favoriteResponseSchema.parse(added.json()).favorite!;
    expect(dto.itemId).toBe(ids.movie);
    expect(dto.item.title).toBe("Матрица");
    expect(dto.item.type).toBe("movie");

    // Повторный PUT не создаёт вторую закладку.
    await app.app.inject({
      method: "PUT",
      url: `/v1/favorites/${ids.movie}`,
      headers: auth,
    });
    const list = await app.app.inject({ method: "GET", url: "/v1/favorites", headers: auth });
    const items = favoriteListResponseSchema.parse(list.json()).items;
    expect(items).toHaveLength(1);

    const removed = await app.app.inject({
      method: "DELETE",
      url: `/v1/favorites/${ids.movie}`,
      headers: auth,
    });
    expect(favoriteResponseSchema.parse(removed.json()).favorite).toBeNull();
    const after = await app.app.inject({ method: "GET", url: "/v1/favorites", headers: auth });
    expect(favoriteListResponseSchema.parse(after.json()).items).toHaveLength(0);
  });

  it("404 на несуществующий тайтл и 401 без токена", async () => {
    const app = await createTestApp();
    const token = await registerUser(app, "fav2@zal.local");

    const missing = await app.app.inject({
      method: "PUT",
      url: "/v1/favorites/99999",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);

    const unauth = await app.app.inject({ method: "GET", url: "/v1/favorites" });
    expect(unauth.statusCode).toBe(401);
  });
});

describe("profile: подборки", () => {
  it("создаёт подборку, кладёт тайтлы, считает и удаляет", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "lists@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.app.inject({
      method: "POST",
      url: "/v1/lists",
      headers: auth,
      payload: { title: "На выходные", description: "Смотреть вдвоём" },
    });
    expect(created.statusCode).toBe(201);
    const list = userListResponseSchema.parse(created.json()).list;
    expect(list).toMatchObject({ title: "На выходные", itemCount: 0, isPublic: false });

    const withItem = await app.app.inject({
      method: "PUT",
      url: `/v1/lists/${list.id}/items/${ids.movie}`,
      headers: auth,
    });
    expect(withItem.statusCode).toBe(200);
    const detail = userListDetailResponseSchema.parse(withItem.json()).list;
    expect(detail.items.map((i) => i.id)).toEqual([ids.movie]);
    expect(detail.itemCount).toBe(1);

    // Второй тайтл встаёт в конец.
    const twoItems = await app.app.inject({
      method: "PUT",
      url: `/v1/lists/${list.id}/items/${ids.serial}`,
      headers: auth,
    });
    expect(
      userListDetailResponseSchema.parse(twoItems.json()).list.items.map((i) => i.id),
    ).toEqual([ids.movie, ids.serial]);

    // Повторное добавление не дублирует.
    await app.app.inject({
      method: "PUT",
      url: `/v1/lists/${list.id}/items/${ids.movie}`,
      headers: auth,
    });
    const stable = await app.app.inject({
      method: "GET",
      url: `/v1/lists/${list.id}`,
      headers: auth,
    });
    expect(userListDetailResponseSchema.parse(stable.json()).list.items).toHaveLength(2);

    const removed = await app.app.inject({
      method: "DELETE",
      url: `/v1/lists/${list.id}/items/${ids.movie}`,
      headers: auth,
    });
    expect(
      userListDetailResponseSchema.parse(removed.json()).list.items.map((i) => i.id),
    ).toEqual([ids.serial]);

    const all = await app.app.inject({ method: "GET", url: "/v1/lists", headers: auth });
    const lists = userListListResponseSchema.parse(all.json()).items;
    expect(lists).toHaveLength(1);
    expect(lists[0]?.itemCount).toBe(1);

    const deleted = await app.app.inject({
      method: "DELETE",
      url: `/v1/lists/${list.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(200);
    const gone = await app.app.inject({
      method: "GET",
      url: `/v1/lists/${list.id}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(404);
  });

  it("чужая подборка невидима и не правится", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const ownerToken = await registerUser(app, "list-owner@zal.local");
    const otherToken = await registerUser(app, "list-other@zal.local");

    const created = await app.app.inject({
      method: "POST",
      url: "/v1/lists",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Личное" },
    });
    const list = userListResponseSchema.parse(created.json()).list;

    const foreign = { authorization: `Bearer ${otherToken}` };
    const read = await app.app.inject({
      method: "GET",
      url: `/v1/lists/${list.id}`,
      headers: foreign,
    });
    expect(read.statusCode).toBe(404);

    const write = await app.app.inject({
      method: "PUT",
      url: `/v1/lists/${list.id}/items/${ids.movie}`,
      headers: foreign,
    });
    expect(write.statusCode).toBe(404);

    const patch = await app.app.inject({
      method: "PATCH",
      url: `/v1/lists/${list.id}`,
      headers: foreign,
      payload: { title: "Захвачено" },
    });
    expect(patch.statusCode).toBe(404);
  });
});

describe("profile: история просмотра", () => {
  it("показывает серию с номером сезона, прогрессом и очищается", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "hist@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    await app.app.inject({
      method: "PUT",
      url: `/v1/progress/${ids.episodeMedia}`,
      headers: auth,
      payload: { positionSeconds: 31, durationSeconds: 62 },
    });
    await app.app.inject({
      method: "PUT",
      url: `/v1/progress/${ids.movieMedia}`,
      headers: auth,
      payload: { positionSeconds: 136, durationSeconds: 136 },
    });

    const list = await app.app.inject({ method: "GET", url: "/v1/history", headers: auth });
    const body = historyListResponseSchema.parse(list.json());
    expect(body.total).toBe(2);

    const episode = body.items.find((i) => i.mediaId === ids.episodeMedia)!;
    expect(episode).toMatchObject({
      itemId: ids.serial,
      seasonNumber: 1,
      episodeNumber: 1,
      partNumber: null,
      progress: 0.5,
      status: "in_progress",
    });

    const movie = body.items.find((i) => i.mediaId === ids.movieMedia)!;
    expect(movie).toMatchObject({ status: "watched", progress: 1, partNumber: null });

    // Удаление одной записи не трогает остальные.
    const one = await app.app.inject({
      method: "DELETE",
      url: `/v1/history/${ids.episodeMedia}`,
      headers: auth,
    });
    expect(one.statusCode).toBe(200);
    const afterOne = await app.app.inject({
      method: "GET",
      url: "/v1/history",
      headers: auth,
    });
    expect(historyListResponseSchema.parse(afterOne.json()).total).toBe(1);

    const cleared = await app.app.inject({
      method: "DELETE",
      url: "/v1/history",
      headers: auth,
    });
    expect(cleared.json()).toMatchObject({ ok: true, removed: 1 });
    const empty = await app.app.inject({ method: "GET", url: "/v1/history", headers: auth });
    expect(historyListResponseSchema.parse(empty.json()).total).toBe(0);
  });
});

describe("profile: прогресс по тайтлу", () => {
  it("отдаёт записи по всем media и указывает, где продолжить", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "item-progress@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    // До сохранения — пусто и нет resume.
    const empty = await app.app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/progress`,
      headers: auth,
    });
    const emptyDto = itemProgressResponseSchema.parse(empty.json()).progress;
    expect(emptyDto.entries).toHaveLength(0);
    expect(emptyDto.resumeMediaId).toBeNull();

    await app.app.inject({
      method: "PUT",
      url: `/v1/progress/${ids.episodeMedia}`,
      headers: auth,
      payload: { positionSeconds: 15, durationSeconds: 62 },
    });

    const res = await app.app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/progress`,
      headers: auth,
    });
    const dto = itemProgressResponseSchema.parse(res.json()).progress;
    expect(dto.itemId).toBe(ids.serial);
    expect(dto.entries).toHaveLength(1);
    expect(dto.entries[0]).toMatchObject({
      mediaId: ids.episodeMedia,
      status: "in_progress",
    });
    expect(dto.resumeMediaId).toBe(ids.episodeMedia);
    expect(dto.resumePositionSeconds).toBe(15);

    // Досмотренная серия не подставляется в «продолжить».
    await app.app.inject({
      method: "PUT",
      url: `/v1/progress/${ids.episodeMedia}`,
      headers: auth,
      payload: { positionSeconds: 62, durationSeconds: 62 },
    });
    const after = await app.app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/progress`,
      headers: auth,
    });
    expect(itemProgressResponseSchema.parse(after.json()).progress.resumeMediaId).toBeNull();
  });
});

describe("profile: сводка", () => {
  it("считает закладки, подборки, историю, подписки и комментарии", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "overview@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    await app.app.inject({
      method: "PUT",
      url: `/v1/favorites/${ids.movie}`,
      headers: auth,
    });
    await app.app.inject({
      method: "POST",
      url: "/v1/lists",
      headers: auth,
      payload: { title: "Подборка" },
    });
    await app.app.inject({
      method: "PUT",
      url: `/v1/progress/${ids.movieMedia}`,
      headers: auth,
      payload: { positionSeconds: 136, durationSeconds: 136 },
    });
    await app.app.inject({
      method: "PUT",
      url: `/v1/subscriptions/${ids.serial}`,
      headers: auth,
      payload: { notify: true },
    });
    await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      headers: auth,
      payload: { body: "Отличный фильм" },
    });

    const res = await app.app.inject({
      method: "GET",
      url: "/v1/profile/overview",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const profile = profileOverviewResponseSchema.parse(res.json()).profile;
    expect(profile.user.email).toBe("overview@zal.local");
    expect(profile.stats).toMatchObject({
      favorites: 1,
      lists: 1,
      history: 1,
      watched: 1,
      inProgress: 0,
      subscriptions: 1,
      comments: 1,
    });
    expect(profile.favorites).toHaveLength(1);
    expect(profile.lists).toHaveLength(1);
    expect(profile.history[0]?.mediaId).toBe(ids.movieMedia);
  });

  it("401 без токена", async () => {
    const app = await createTestApp();
    const res = await app.app.inject({ method: "GET", url: "/v1/profile/overview" });
    expect(res.statusCode).toBe(401);
  });
});
