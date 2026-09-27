"use client";

/**
 * Дерево комментариев: плоский список из API собирается в дерево на клиенте.
 * Ответы, правка и мягкое удаление — как на вебе.
 */
import * as React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { CommentDto } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { useAuth } from "../lib/auth";
import { buildCommentTree, type CommentNode } from "../lib/comment-tree";
import { formatDate } from "../lib/format";

interface BodyFormProps {
  label: string;
  testId: string;
  initial?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}

function BodyForm({ label, testId, initial = "", onSubmit, onCancel }: BodyFormProps) {
  const [body, setBody] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);

  return (
    <View style={styles.form} testID={testId}>
      <TextInput
        testID={`${testId}-input`}
        style={styles.input}
        value={body}
        onChangeText={setBody}
        placeholder="Ваш комментарий…"
        placeholderTextColor={tokens.color.textMuted}
        multiline
      />
      <View style={styles.formButtons}>
        <Pressable
          testID={`${testId}-submit`}
          style={[styles.smallButton, (!body.trim() || busy) && styles.buttonOff]}
          disabled={!body.trim() || busy}
          onPress={async () => {
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
          <Text style={styles.smallButtonText}>{label}</Text>
        </Pressable>
        <Pressable onPress={onCancel}>
          <Text style={styles.mutedText}>Отмена</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface CommentRowProps {
  node: CommentNode;
  currentUserId: number | null;
  onReply: (parentId: number, body: string) => Promise<void>;
  onEdit: (id: number, body: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

function CommentRow({ node, currentUserId, onReply, onEdit, onDelete }: CommentRowProps) {
  const [replying, setReplying] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const { comment, children } = node;
  const own = currentUserId != null && comment.author.id === currentUserId;

  return (
    <View style={[styles.node, { marginLeft: Math.min(comment.depth, 6) * 12 }]} testID="comment-item">
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.author}>{comment.author.name}</Text>
          <Text style={styles.mutedText}>{formatDate(comment.createdAt)}</Text>
          {comment.updatedAt !== comment.createdAt && (
            <Text style={styles.mutedText}>(изменён)</Text>
          )}
        </View>

        {comment.deleted ? (
          <Text style={styles.deletedText}>Комментарий удалён</Text>
        ) : editing ? (
          <BodyForm
            label="Сохранить"
            testId="edit-form"
            initial={comment.body}
            onCancel={() => setEditing(false)}
            onSubmit={(body) => onEdit(comment.id, body)}
          />
        ) : (
          <Text style={styles.body}>{comment.body}</Text>
        )}

        {!comment.deleted && !editing && (
          <View style={styles.actionsRow}>
            <Pressable onPress={() => setReplying((v) => !v)}>
              <Text style={styles.actionText}>Ответить</Text>
            </Pressable>
            {own && (
              <Pressable onPress={() => setEditing(true)}>
                <Text style={styles.actionText}>Изменить</Text>
              </Pressable>
            )}
            {own && (
              <Pressable
                testID="delete-comment"
                onPress={() => void onDelete(comment.id)}
              >
                <Text style={[styles.actionText, styles.deleteText]}>Удалить</Text>
              </Pressable>
            )}
          </View>
        )}

        {replying && (
          <BodyForm
            label="Ответить"
            testId="reply-form"
            onCancel={() => setReplying(false)}
            onSubmit={(body) => onReply(comment.id, body)}
          />
        )}
      </View>

      {children.map((child) => (
        <CommentRow
          key={child.comment.id}
          node={child}
          currentUserId={currentUserId}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </View>
  );
}

export function Comments({ itemId }: { itemId: number }) {
  const { user, api } = useAuth();
  const [flat, setFlat] = React.useState<CommentDto[]>([]);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [total, setTotal] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    api.listComments(itemId).then(
      (res) => {
        if (cancelled) return;
        setFlat(res.items);
        setNextOffset(res.nextOffset);
        setTotal(res.total);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);

  const add = React.useCallback(
    async (parentId: number | null, body: string) => {
      const res = await api.postComment(itemId, { body, parentId });
      setFlat((prev) => [...prev, res.comment]);
      if (parentId === null) setTotal((t) => t + 1);
    },
    [api, itemId],
  );

  const edit = React.useCallback(
    async (id: number, body: string) => {
      const res = await api.editComment(id, { body });
      setFlat((prev) => prev.map((c) => (c.id === id ? res.comment : c)));
    },
    [api],
  );

  const remove = React.useCallback(
    async (id: number) => {
      await api.deleteComment(id);
      setFlat((prev) =>
        prev.map((c) => (c.id === id ? { ...c, deleted: true, body: "" } : c)),
      );
    },
    [api],
  );

  const loadMore = React.useCallback(async () => {
    if (nextOffset == null) return;
    const res = await api.listComments(itemId, { offset: nextOffset });
    setFlat((prev) => {
      const seen = new Set(prev.map((c) => c.id));
      return [...prev, ...res.items.filter((c) => !seen.has(c.id))];
    });
    setNextOffset(res.nextOffset);
  }, [api, itemId, nextOffset]);

  const tree = buildCommentTree(flat);

  return (
    <View style={styles.root} testID="comments">
      <Text style={styles.title} testID="comments-total">
        Комментарии ({total})
      </Text>

      {user ? (
        <BodyForm
          label="Отправить"
          testId="comment-form"
          onCancel={() => {}}
          onSubmit={(body) => add(null, body)}
        />
      ) : (
        <Text style={styles.mutedText}>Войдите, чтобы оставить комментарий.</Text>
      )}

      {tree.map((node) => (
        <CommentRow
          key={node.comment.id}
          node={node}
          currentUserId={user?.id ?? null}
          onReply={add}
          onEdit={edit}
          onDelete={remove}
        />
      ))}

      {nextOffset != null && (
        <Pressable style={styles.moreButton} onPress={() => void loadMore()}>
          <Text style={styles.actionText}>Показать ещё</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginTop: tokens.space.lg,
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
    marginBottom: tokens.space.sm,
  },
  node: {
    marginBottom: tokens.space.sm,
  },
  card: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border,
    padding: tokens.space.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: tokens.space.sm,
    flexWrap: "wrap",
  },
  author: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  body: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    marginTop: tokens.space.xs,
  },
  deletedText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
    fontStyle: "italic",
    marginTop: tokens.space.xs,
  },
  actionsRow: {
    flexDirection: "row",
    gap: tokens.space.md,
    marginTop: tokens.space.sm,
  },
  actionText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.xs,
  },
  deleteText: {
    color: "#e57373",
  },
  mutedText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.xs,
  },
  form: {
    marginTop: tokens.space.sm,
  },
  formButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.md,
    marginTop: tokens.space.xs,
  },
  smallButton: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.xs,
  },
  buttonOff: {
    opacity: 0.5,
  },
  smallButtonText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  input: {
    backgroundColor: tokens.color.surfaceHover,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border,
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    padding: tokens.space.sm,
    minHeight: 56,
    textAlignVertical: "top",
  },
  moreButton: {
    alignItems: "center",
    paddingVertical: tokens.space.sm,
  },
});
