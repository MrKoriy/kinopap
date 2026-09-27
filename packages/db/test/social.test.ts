/** Тесты социального слоя: подписки, лента новых серий, голоса, дерево комментариев. */
import { describe, expect, it } from "vitest";
import { createTestDb, seedFixtures } from "./helpers";
import {
  MAX_COMMENT_DEPTH,
  addComment,
  listCommentsPage,
  countComments,
  createUser,
  deleteSubscription,
  getDefaultProfile,
  getSubscription,
  getVoteState,
  hashPassword,
  listComments,
  listNewEpisodes,
  media,
  listSubscriptions,
  removeVote,
  setVote,
  softDeleteComment,
  updateComment,
  upsertProgress,
  upsertSubscription,
} from "../src/index";

async function makeUser(db: Awaited<ReturnType<typeof createTestDb>>, email: string) {
  const user = await createUser(db, {
    email,
    passwordHash: await hashPassword("password-123"),
    name: email.split("@")[0]!,
  });
  const profile = await getDefaultProfile(db, user.id);
  return { user, profile };
}

describe("подписки", () => {
  it("идемпотентная подписка, список, отписка", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const { profile } = await makeUser(db, "a@zal.local");

    const sub = await upsertSubscription(db, profile.id, f.matrix, true);
    expect(sub).toMatchObject({ itemId: f.matrix, notify: true });
    expect(sub.item.title).toBe("Матрица");

    // Повторная подписка не плодит строки и обновляет notify.
    await upsertSubscription(db, profile.id, f.matrix, false);
    const again = await getSubscription(db, profile.id, f.matrix);
    expect(again?.notify).toBe(false);

    const list = await listSubscriptions(db, profile.id);
    expect(list).toHaveLength(1);

    expect(await deleteSubscription(db, profile.id, f.matrix)).toBe(true);
    expect(await getSubscription(db, profile.id, f.matrix)).toBeNull();
    expect(await deleteSubscription(db, profile.id, f.matrix)).toBe(false);
  });

  it("лента новых серий: только подписки и только недосмотренные", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const { profile } = await makeUser(db, "b@zal.local");
    const ep1Media = (
      await db.query.media.findMany({
        where: (m, { eq, and, isNotNull }) =>
          and(eq(m.itemId, f.got), isNotNull(m.episodeId)),
      })
    ).sort((a, b) => a.id - b.id);

    // Без подписок — пусто.
    expect(await listNewEpisodes(db, profile.id)).toEqual({ items: [], total: 0 });

    await upsertSubscription(db, profile.id, f.got, true);
    // Подписка на фильм без серий не добавляет строк.
    await upsertSubscription(db, profile.id, f.matrix, true);

    const feed = await listNewEpisodes(db, profile.id);
    expect(feed.total).toBe(2);
    expect(feed.items).toHaveLength(2);
    expect(feed.items.map((e) => e.itemTitle)).toEqual([
      "Игра престолов",
      "Игра престолов",
    ]);
    expect(feed.items.every((e) => e.kind === "episode")).toBe(true);

    // Досмотрели первую серию → она уходит из ленты.
    await upsertProgress(db, {
      profileId: profile.id,
      itemId: f.got,
      mediaId: ep1Media[0]!.id,
      positionSeconds: 62,
      durationSeconds: 62,
    });
    const after = await listNewEpisodes(db, profile.id);
    expect(after.total).toBe(1);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.mediaId).toBe(ep1Media[1]!.id);
  });

  it("новые части фильмов попадают в ленту как part", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const { profile } = await makeUser(db, "parts@zal.local");

    // Вторая часть фильма — новинка; первая часть — нет.
    const [part2] = await db
      .insert(media)
      .values({ itemId: f.matrix, partNumber: 2, title: "Финал", runtime: 120 })
      .returning();
    await upsertSubscription(db, profile.id, f.matrix, true);

    const feed = await listNewEpisodes(db, profile.id);
    expect(feed.total).toBe(1);
    expect(feed.items[0]).toMatchObject({
      kind: "part",
      itemId: f.matrix,
      mediaId: part2!.id,
      partNumber: 2,
      title: "Финал",
      seasonNumber: null,
      episodeNumber: null,
    });

    // Досмотренная часть уходит из ленты.
    await upsertProgress(db, {
      profileId: profile.id,
      itemId: f.matrix,
      mediaId: part2!.id,
      positionSeconds: 120,
      durationSeconds: 120,
    });
    expect((await listNewEpisodes(db, profile.id)).total).toBe(0);
  });
});

describe("голосование", () => {
  it("счётчики, смена голоса, снятие и рейтинг 0..10", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const { profile: p1 } = await makeUser(db, "v1@zal.local");
    const { profile: p2 } = await makeUser(db, "v2@zal.local");

    const v1 = await setVote(db, p1.id, f.matrix, true);
    expect(v1).toMatchObject({ myVote: true, votes: { positive: 1, negative: 0, total: 1 } });

    // Повтор тем же голосом — no-op.
    const repeat = await setVote(db, p1.id, f.matrix, true);
    expect(repeat.votes).toEqual({ positive: 1, negative: 0, total: 1 });

    // Смена голоса: перевес.
    const flipped = await setVote(db, p1.id, f.matrix, false);
    expect(flipped).toMatchObject({ myVote: false, votes: { positive: 0, negative: 1, total: 1 } });

    // Второй пользователь — суммы складываются.
    await setVote(db, p2.id, f.matrix, true);
    const state = await getVoteState(db, p2.id, f.matrix);
    expect(state!.votes).toEqual({ positive: 1, negative: 1, total: 2 });

    // Рейтинг хранится в items: 5 = половина «за».
    const rows = await db.query.items.findMany({
      where: (i, { eq }) => eq(i.id, f.matrix),
    });
    expect(rows[0]!.rating).toBe(5);

    // Снятие голоса уводит его из сумм.
    const after = await removeVote(db, p1.id, f.matrix);
    expect(after).toMatchObject({ myVote: null, votes: { positive: 1, negative: 0, total: 1 } });
    const row2 = (await db.query.items.findMany({ where: (i, { eq }) => eq(i.id, f.matrix) }))[0]!;
    expect(row2.rating).toBe(10);
  });

  it("голос по несуществующему тайтлу — null", async () => {
    const db = await createTestDb();
    const { profile } = await makeUser(db, "v3@zal.local");
    expect(await getVoteState(db, profile.id, 999)).toBeNull();
  });
});

describe("комментарии", () => {
  it("дерево, глубина зажимается, мягкое удаление", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const { profile: p1 } = await makeUser(db, "c1@zal.local");
    const { profile: p2 } = await makeUser(db, "c2@zal.local");

    const root = await addComment(db, {
      itemId: f.matrix,
      profileId: p1.id,
      body: "Отличный фильм",
    });
    expect(root).toMatchObject({ parentId: null, depth: 0, deleted: false });
    expect(root.author.name).toBe("c1");

    const reply = await addComment(db, {
      itemId: f.matrix,
      profileId: p2.id,
      parentId: root.id,
      body: "Согласен!",
    });
    expect(reply).toMatchObject({ parentId: root.id, depth: 1 });
    // author.id — id аккаунта, а не профиля.
    expect(reply.author.id).toBe(p2.userId);

    // Цепочка глубже лимита зажимается MAX_COMMENT_DEPTH.
    let last = reply;
    for (let i = 0; i < MAX_COMMENT_DEPTH + 2; i++) {
      last = await addComment(db, {
        itemId: f.matrix,
        profileId: p1.id,
        parentId: last.id,
        body: `уровень ${i}`,
      });
    }
    expect(last.depth).toBe(MAX_COMMENT_DEPTH);

    // Родитель из другого тайтла отклоняется.
    await expect(
      addComment(db, {
        itemId: f.got,
        profileId: p1.id,
        parentId: root.id,
        body: "не туда",
      }),
    ).rejects.toThrow("parent_not_found");

    // Мягкое удаление: узел остаётся, тело чистится.
    expect(await softDeleteComment(db, root.id)).toBe(true);
    expect(await softDeleteComment(db, root.id)).toBe(false);
    const all = await listComments(db, f.matrix);
    const deletedRoot = all.find((c) => c.id === root.id)!;
    expect(deletedRoot.deleted).toBe(true);
    expect(deletedRoot.body).toBe("");
    // Дерево не рассыпалось: ответ на месте.
    expect(all.some((c) => c.parentId === root.id)).toBe(true);

    // Счётчик считает только живые.
    expect(await countComments(db, f.matrix)).toBe(all.length - 1);
  });

  it("редактирование переносит updatedAt и не трогает удалённые", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const { profile } = await makeUser(db, "editor@zal.local");

    const c = await addComment(db, {
      itemId: f.matrix,
      profileId: profile.id,
      body: "черновик",
    });
    expect(c.updatedAt).toBe(c.createdAt);

    const edited = await updateComment(db, c.id, "готово");
    expect(edited!.body).toBe("готово");
    expect(edited!.updatedAt >= c.createdAt).toBe(true);

    // Удалённый не редактируется.
    await softDeleteComment(db, c.id);
    expect(await updateComment(db, c.id, "мимо")).toBeNull();
  });

  it("постраничная выдача отдаёт ветки целиком", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const { profile } = await makeUser(db, "pager@zal.local");

    // 3 ветки: в первой два ответа.
    const r1 = await addComment(db, { itemId: f.matrix, profileId: profile.id, body: "в1" });
    await addComment(db, {
      itemId: f.matrix,
      profileId: profile.id,
      parentId: r1.id,
      body: "в1.1",
    });
    await addComment(db, { itemId: f.matrix, profileId: profile.id, body: "в2" });
    await addComment(db, { itemId: f.matrix, profileId: profile.id, body: "в3" });

    const page1 = await listCommentsPage(db, f.matrix, 2, 0);
    expect(page1.total).toBe(3);
    expect(page1.nextOffset).toBe(2);
    // Страница — ветки целиком: 2 корня + ответ первой ветки.
    expect(page1.items).toHaveLength(3);
    expect(page1.items.map((c) => c.body)).toEqual(["в1", "в1.1", "в2"]);

    const page2 = await listCommentsPage(db, f.matrix, 2, 2);
    expect(page2.nextOffset).toBeNull();
    expect(page2.items.map((c) => c.body)).toEqual(["в3"]);
  });
});
