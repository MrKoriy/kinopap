import type { CommentDto } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { buildCommentTree } from "../src";

function comment(id: number, parentId: number | null, body = `c${id}`): CommentDto {
  return {
    id,
    parentId,
    body,
    author: { id: 1, name: "Аноним" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: null,
    deleted: false,
    children: null,
  } as unknown as CommentDto;
}

describe("buildCommentTree", () => {
  it("вкладывает ответы и держит порядок корней", () => {
    const tree = buildCommentTree([
      comment(1, null),
      comment(2, 1),
      comment(3, 2),
      comment(4, null),
    ]);
    expect(tree.map((n) => n.comment.id)).toEqual([1, 4]);
    expect(tree[0]!.children[0]!.comment.id).toBe(2);
    expect(tree[0]!.children[0]!.children[0]!.comment.id).toBe(3);
  });

  it("сирота (родитель не в выдаче) становится корнем", () => {
    const tree = buildCommentTree([comment(5, 99)]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.comment.id).toBe(5);
  });
});
