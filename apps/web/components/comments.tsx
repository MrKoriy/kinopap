"use client";

/**
 * Дерево комментариев: плоский список из API собирается в дерево на клиенте.
 * Ответы вкладываются до MAX_COMMENT_DEPTH, удалённые узлы остаются в ветке.
 */
import * as React from "react";
import type { CommentDto } from "@zal/api-client";
import { useOptionalAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";

interface TreeNode {
  comment: CommentDto;
  children: TreeNode[];
}

export function buildCommentTree(flat: CommentDto[]): TreeNode[] {
  const byId = new Map<number, TreeNode>();
  for (const c of flat) byId.set(c.id, { comment: c, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent =
      node.comment.parentId != null ? byId.get(node.comment.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

interface ReplyFormProps {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  testId: string;
}

function ReplyForm({ onSubmit, onCancel, testId }: ReplyFormProps) {
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <form
      className="mt-2 flex gap-2"
      data-testid={testId}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim() || busy) return;
        setBusy(true);
        try {
          await onSubmit(body.trim());
          setBody("");
          onCancel();
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea
        className="flex-1 rounded border border-border bg-surface-2 px-3 py-2 text-sm text-white outline-none focus:border-accent"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Ваш ответ…"
        data-testid={`${testId}-input`}
      />
      <button
        type="submit"
        disabled={busy || !body.trim()}
        className="self-end rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
        data-testid={`${testId}-submit`}
      >
        Ответить
      </button>
      <button
        type="button"
        className="self-end px-2 text-sm text-muted transition hover:text-white"
        onClick={onCancel}
      >
        Отмена
      </button>
    </form>
  );
}

interface CommentNodeProps {
  node: TreeNode;
  currentUserId: number | null;
  onReply: (parentId: number, body: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

function CommentNode({ node, currentUserId, onReply, onDelete }: CommentNodeProps) {
  const [replying, setReplying] = React.useState(false);
  const { comment, children } = node;
  const own = currentUserId != null && comment.author.id === currentUserId;

  return (
    <li data-testid="comment-item" data-comment-id={comment.id}>
      <div
        className="rounded-[var(--radius-card)] border border-border bg-surface-2 p-3"
        style={{ marginLeft: Math.min(comment.depth, 6) * 24 }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-white" data-testid="comment-author">
            {comment.author.name}
          </span>
          <span className="text-xs text-muted">{formatDate(comment.createdAt)}</span>
        </div>
        {comment.deleted ? (
          <p className="mt-1 text-sm italic text-muted" data-testid="comment-deleted">
            Комментарий удалён
          </p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/90" data-testid="comment-body">
            {comment.body}
          </p>
        )}
        {!comment.deleted && (
          <div className="mt-2 flex gap-3 text-xs">
            <button
              className="text-muted transition hover:text-white"
              onClick={() => setReplying((v) => !v)}
              data-testid="reply-button"
            >
              Ответить
            </button>
            {own && (
              <button
                className="text-muted transition hover:text-red-400"
                onClick={() => void onDelete(comment.id)}
                data-testid="delete-comment"
              >
                Удалить
              </button>
            )}
          </div>
        )}
        {replying && (
          <ReplyForm
            testId="reply-form"
            onCancel={() => setReplying(false)}
            onSubmit={(body) => onReply(comment.id, body)}
          />
        )}
      </div>
      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <CommentNode
              key={child.comment.id}
              node={child}
              currentUserId={currentUserId}
              onReply={onReply}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Comments({ itemId }: { itemId: number }) {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;
  const [flat, setFlat] = React.useState<CommentDto[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.listComments(itemId).then(
      (res) => {
        if (!cancelled) {
          setFlat(res.items);
          setLoaded(true);
        }
      },
      () => {
        if (!cancelled) setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);

  const add = React.useCallback(
    async (parentId: number | null, body: string) => {
      if (!api) return;
      const res = await api.postComment(itemId, { body, parentId });
      setFlat((prev) => [...prev, res.comment]);
    },
    [api, itemId],
  );

  const remove = React.useCallback(
    async (id: number) => {
      if (!api) return;
      await api.deleteComment(id);
      // Узел остаётся в дереве с пометкой «удалён».
      setFlat((prev) =>
        prev.map((c) => (c.id === id ? { ...c, deleted: true, body: "" } : c)),
      );
    },
    [api, itemId],
  );

  const tree = buildCommentTree(flat);

  return (
    <section className="mt-12" data-testid="comments">
      <h2 className="mb-4 text-xl font-bold text-white">
        Комментарии <span className="text-muted" data-testid="comments-count">({flat.filter((c) => !c.deleted).length})</span>
      </h2>

      {user && api ? (
        <ReplyForm
          testId="comment-form"
          onCancel={() => {}}
          onSubmit={(body) => add(null, body)}
        />
      ) : (
        <p className="mb-4 text-sm text-muted">
          <a href="/login" className="text-accent hover:underline">
            Войдите
          </a>
          , чтобы оставить комментарий.
        </p>
      )}

      {loaded && tree.length === 0 && (
        <p className="text-sm text-muted" data-testid="comments-empty">
          Пока тихо. Будьте первым.
        </p>
      )}

      <ul className="space-y-3">
        {tree.map((node) => (
          <CommentNode
            key={node.comment.id}
            node={node}
            currentUserId={user?.id ?? null}
            onReply={add}
            onDelete={remove}
          />
        ))}
      </ul>
    </section>
  );
}
