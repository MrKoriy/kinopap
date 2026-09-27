import type { CommentDto } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { buildCommentTree } from "../lib/comment-tree";
import { feedLabel, feedTitle } from "../lib/feed";

describe("feedLabel / feedTitle", () => {
  it("серии подписываются как S1E2", () => {
    expect(
      feedLabel({ kind: "episode", seasonNumber: 1, episodeNumber: 2, partNumber: null }),
    ).toBe("S1E2");
  });

  it("новые части фильмов — «Часть N»", () => {
    expect(
      feedLabel({ kind: "part", seasonNumber: null, episodeNumber: null, partNumber: 3 }),
    ).toBe("Часть 3");
    expect(
      feedLabel({ kind: "part", seasonNumber: null, episodeNumber: null, partNumber: null }),
    ).toBe("Часть ?");
  });

  it("полный заголовок склеивает тайтл и имя", () => {
    expect(
      feedTitle({ kind: "episode", itemTitle: "Игра", episodeTitle: "Зима", title: null }),
    ).toBe("Игра — Зима");
    expect(
      feedTitle({ kind: "part", itemTitle: "Матрица", episodeTitle: null, title: "Финал" }),
    ).toBe("Матрица — Финал");
    expect(
      feedTitle({ kind: "part", itemTitle: "Матрица", episodeTitle: null, title: null }),
    ).toBe("Матрица");
  });
});

describe("buildCommentTree", () => {
  const comment = (over: Partial<CommentDto>): CommentDto => ({
    id: 1,
    itemId: 10,
    parentId: null,
    depth: 0,
    body: "текст",
    deleted: false,
    author: { id: 7, name: "fan" },
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...over,
  });

  it("собирает вложенность из плоского списка", () => {
    const flat = [
      comment({ id: 3, parentId: 1, depth: 1 }),
      comment({ id: 1 }),
      comment({ id: 2, parentId: 1, depth: 1 }),
      comment({ id: 4 }),
    ];
    const tree = buildCommentTree(flat);
    expect(tree.map((n) => n.comment.id)).toEqual([1, 4]);
    expect(tree[0]!.children.map((n) => n.comment.id)).toEqual([3, 2]);
  });

  it("ответ на удалённый узел не теряется", () => {
    const flat = [
      comment({ id: 1, deleted: true, body: "" }),
      comment({ id: 2, parentId: 1, depth: 1 }),
    ];
    const tree = buildCommentTree(flat);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
  });
});
