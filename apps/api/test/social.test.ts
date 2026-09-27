/** Тесты социальных роутов: подписки, комментарии, голосование. */
import { describe, expect, it } from "vitest";
import {
  commentListResponseSchema,
  commentResponseSchema,
  itemSocialResponseSchema,
  newEpisodesResponseSchema,
  subscriptionListResponseSchema,
  subscriptionResponseSchema,
  voteResponseSchema,
} from "@zal/api-client";
import { createTestApp } from "./setup";
import { makeFixtures, makeOwnerWithInvite } from "./fixtures";

type App = Awaited<ReturnType<typeof createTestApp>>;

/** Обычный участник (без owner — права staff не нужны). */
async function registerUser(app: App, email: string): Promise<string> {
  const { invite } = await makeOwnerWithInvite(app.db);
  const reg = await app.app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { invite, email, password: "hunter2hunter2", name: email },
  });
  expect(reg.statusCode).toBe(201);
  return (reg.json().tokens as { accessToken: string }).accessToken;
}

describe("social routes", () => {
  it("подписка, список, лента новых серий, отписка", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "sub-fan@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    const sub = await app.app.inject({
      method: "PUT",
      url: `/v1/subscriptions/${ids.serial}`,
      headers: auth,
      payload: { notify: true },
    });
    expect(sub.statusCode).toBe(200);
    const dto = subscriptionResponseSchema.parse(sub.json()).subscription!;
    expect(dto).toMatchObject({ itemId: ids.serial, notify: true });
    expect(dto.item.title).toBe("Игра престолов");

    // Повтор — идемпотентно.
    const again = await app.app.inject({
      method: "PUT",
      url: `/v1/subscriptions/${ids.serial}`,
      headers: auth,
      payload: {},
    });
    expect(subscriptionResponseSchema.parse(again.json()).subscription?.itemId).toBe(ids.serial);

    const list = await app.app.inject({ method: "GET", url: "/v1/subscriptions", headers: auth });
    expect(subscriptionListResponseSchema.parse(list.json()).items).toHaveLength(1);

    // Лента новых серий: у фикстурного сериала есть эпизод с media.
    const feed = await app.app.inject({
      method: "GET",
      url: "/v1/subscriptions/new-episodes",
      headers: auth,
    });
    const episodes = newEpisodesResponseSchema.parse(feed.json()).items;
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      itemId: ids.serial,
      mediaId: ids.episodeMedia,
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const un = await app.app.inject({
      method: "DELETE",
      url: `/v1/subscriptions/${ids.serial}`,
      headers: auth,
    });
    expect(subscriptionResponseSchema.parse(un.json()).subscription).toBeNull();

    // Подписка на несуществующий тайтл — 404, без токена — 401.
    const missing = await app.app.inject({
      method: "PUT",
      url: "/v1/subscriptions/99999",
      headers: auth,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    const anon = await app.app.inject({
      method: "PUT",
      url: `/v1/subscriptions/${ids.serial}`,
      payload: {},
    });
    expect(anon.statusCode).toBe(401);
  });

  it("комментарии: корень, ответ, удаление, права", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token1 = await registerUser(app, "author@zal.local");
    const token2 = await registerUser(app, "stranger@zal.local");
    const auth1 = { authorization: `Bearer ${token1}` };
    const auth2 = { authorization: `Bearer ${token2}` };

    const root = await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      headers: auth1,
      payload: { body: "Отличный фильм!" },
    });
    expect(root.statusCode).toBe(201);
    const rootDto = commentResponseSchema.parse(root.json()).comment;
    expect(rootDto).toMatchObject({ parentId: null, depth: 0, deleted: false });
    expect(rootDto.author.name).toBe("author@zal.local");

    const reply = await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      headers: auth2,
      payload: { body: "И сиквелы!", parentId: rootDto.id },
    });
    const replyDto = commentResponseSchema.parse(reply.json()).comment;
    expect(replyDto).toMatchObject({ parentId: rootDto.id, depth: 1 });

    const list = await app.app.inject({
      method: "GET",
      url: `/v1/items/${ids.movie}/comments`,
    });
    const items = commentListResponseSchema.parse(list.json()).items;
    expect(items.map((c) => c.id)).toEqual([rootDto.id, replyDto.id]);

    // Ответ на несуществующего родителя — 400, комментарий к чужому тайтлу — 400.
    const orphan = await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      headers: auth1,
      payload: { body: "сирота", parentId: 99999 },
    });
    expect(orphan.statusCode).toBe(400);
    const crossPost = await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      headers: auth1,
      payload: { body: "не туда", parentId: replyDto.id },
    });
    expect(crossPost.statusCode).toBe(201); // replyDto — тот же тайтл, ответ валиден
    const wrongItem = await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.serial}/comments`,
      headers: auth1,
      payload: { body: "не туда", parentId: rootDto.id },
    });
    expect(wrongItem.statusCode).toBe(400);

    // Чужой комментарий удалить нельзя.
    const foreign = await app.app.inject({
      method: "DELETE",
      url: `/v1/comments/${rootDto.id}`,
      headers: auth2,
    });
    expect(foreign.statusCode).toBe(403);

    // Свой — можно, и он остаётся в дереве помеченным.
    const own = await app.app.inject({
      method: "DELETE",
      url: `/v1/comments/${rootDto.id}`,
      headers: auth1,
    });
    expect(own.statusCode).toBe(200);
    const after = await app.app.inject({
      method: "GET",
      url: `/v1/items/${ids.movie}/comments`,
    });
    const deletedDto = commentListResponseSchema.parse(after.json()).items.find(
      (c) => c.id === rootDto.id,
    )!;
    expect(deletedDto.deleted).toBe(true);
    expect(deletedDto.body).toBe("");

    // Повторное удаление — 404.
    const twice = await app.app.inject({
      method: "DELETE",
      url: `/v1/comments/${rootDto.id}`,
      headers: auth1,
    });
    expect(twice.statusCode).toBe(404);

    // Анонимам — только читать.
    const anonPost = await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      payload: { body: "анон" },
    });
    expect(anonPost.statusCode).toBe(401);
  });

  it("голосование: смена, снятие, сводное состояние тайтла", async () => {
    const app = await createTestApp();
    const ids = await makeFixtures(app.db);
    const token = await registerUser(app, "voter@zal.local");
    const auth = { authorization: `Bearer ${token}` };

    const voted = await app.app.inject({
      method: "PUT",
      url: `/v1/items/${ids.movie}/vote`,
      headers: auth,
      payload: { positive: true },
    });
    expect(voted.statusCode).toBe(200);
    expect(voteResponseSchema.parse(voted.json()).vote).toMatchObject({
      myVote: true,
      votes: { positive: 1, negative: 0, total: 1 },
    });

    // Смена голоса.
    const flipped = await app.app.inject({
      method: "PUT",
      url: `/v1/items/${ids.movie}/vote`,
      headers: auth,
      payload: { positive: false },
    });
    expect(voteResponseSchema.parse(flipped.json()).vote).toMatchObject({
      myVote: false,
      votes: { positive: 0, negative: 1, total: 1 },
    });

    // Сводное состояние: голос + подписка + комментарии одним запросом.
    await app.app.inject({
      method: "PUT",
      url: `/v1/subscriptions/${ids.movie}`,
      headers: auth,
      payload: {},
    });
    await app.app.inject({
      method: "POST",
      url: `/v1/items/${ids.movie}/comments`,
      headers: auth,
      payload: { body: "плюс один" },
    });
    const socialRes = await app.app.inject({
      method: "GET",
      url: `/v1/items/${ids.movie}/social`,
      headers: auth,
    });
    const social = itemSocialResponseSchema.parse(socialRes.json()).social;
    expect(social.vote.myVote).toBe(false);
    expect(social.subscription?.itemId).toBe(ids.movie);
    expect(social.commentsCount).toBe(1);

    // Гость: мой голос и подписка — null, счётчики видны.
    const guest = await app.app.inject({ method: "GET", url: `/v1/items/${ids.movie}/social` });
    const guestSocial = itemSocialResponseSchema.parse(guest.json()).social;
    expect(guestSocial.vote.myVote).toBeNull();
    expect(guestSocial.subscription).toBeNull();
    expect(guestSocial.vote.votes.total).toBe(1);

    // Снятие голоса.
    const cleared = await app.app.inject({
      method: "DELETE",
      url: `/v1/items/${ids.movie}/vote`,
      headers: auth,
    });
    expect(voteResponseSchema.parse(cleared.json()).vote).toMatchObject({
      myVote: null,
      votes: { positive: 0, negative: 0, total: 0 },
    });

    // Несуществующий тайтл — 404, аноним — 401.
    const missing = await app.app.inject({
      method: "PUT",
      url: "/v1/items/99999/vote",
      headers: auth,
      payload: { positive: true },
    });
    expect(missing.statusCode).toBe(404);
    const anon = await app.app.inject({
      method: "PUT",
      url: `/v1/items/${ids.movie}/vote`,
      payload: { positive: true },
    });
    expect(anon.statusCode).toBe(401);
  });
});
