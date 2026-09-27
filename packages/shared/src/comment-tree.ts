/**
 * Сборка дерева комментариев из плоского списка API.
 * Один код для веба и мобилы.
 */
import type { CommentDto } from "@zal/api-client";

export interface CommentNode {
  comment: CommentDto;
  children: CommentNode[];
}

export function buildCommentTree(flat: CommentDto[]): CommentNode[] {
  const byId = new Map<number, CommentNode>();
  for (const c of flat) byId.set(c.id, { comment: c, children: [] });
  const roots: CommentNode[] = [];
  for (const node of byId.values()) {
    const parent =
      node.comment.parentId != null ? byId.get(node.comment.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
