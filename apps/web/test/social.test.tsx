import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CommentDto, ItemSocialDto, SubscriptionDto } from "@zal/api-client";

// useOptionalAuth подменяем: компоненты социалки ходят в API через него.
const mocks = vi.hoisted(() => ({
  auth: null as null | { user: unknown; api: Record<string, ReturnType<typeof vi.fn>> },
}));

vi.mock("@/lib/auth", () => ({
  useOptionalAuth: () => mocks.auth,
}));

import { Comments, buildCommentTree } from "@/components/comments";
import { ItemActions } from "@/components/item-actions";

afterEach(cleanup);
beforeEach(() => {
  mocks.auth = null;
});

const user = { id: 7, email: "fan@zal.dev", name: "fan", role: "member", createdAt: "2026-01-01T00:00:00Z" };

function makeComment(over: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 1,
    itemId: 10,
    parentId: null,
    depth: 0,
    body: "Отличный фильм",
    deleted: false,
    author: { id: 7, name: "fan" },
    createdAt: "2026-09-01T12:00:00.000Z",
    ...over,
  };
}

function makeSocial(over: Partial<ItemSocialDto> = {}): ItemSocialDto {
  return {
    vote: { itemId: 10, myVote: null, votes: { positive: 0, negative: 0, total: 0 } },
    subscription: null,
    commentsCount: 0,
    ...over,
  };
}

function makeApi(over: Record<string, unknown> = {}) {
  return {
    listComments: vi.fn().mockResolvedValue({ items: [] }),
    postComment: vi.fn(),
    deleteComment: vi.fn().mockResolvedValue({ ok: true }),
    getItemSocial: vi.fn().mockResolvedValue({ social: makeSocial() }),
    setVote: vi.fn(),
    clearVote: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    ...over,
  } as Record<string, ReturnType<typeof vi.fn>>;
}

describe("buildCommentTree", () => {
  it("собирает дерево из плоского списка", () => {
    const root = makeComment({ id: 1 });
    const reply = makeComment({ id: 2, parentId: 1, depth: 1 });
    const orphan = makeComment({ id: 3 });
    const tree = buildCommentTree([reply, root, orphan]);
    expect(tree.map((n) => n.comment.id)).toEqual([1, 3]);
    expect(tree[0]!.children.map((n) => n.comment.id)).toEqual([2]);
  });
});

describe("Comments", () => {
  it("рендерит дерево: корень и вложенный ответ", async () => {
    const api = makeApi({
      listComments: vi.fn().mockResolvedValue({
        items: [
          makeComment({ id: 1, body: "Корень" }),
          makeComment({ id: 2, parentId: 1, depth: 1, body: "Ответ", author: { id: 8, name: "other" } }),
        ],
      }),
    });
    mocks.auth = { user, api };
    render(<Comments itemId={10} />);

    await waitFor(() => expect(screen.getAllByTestId("comment-item")).toHaveLength(2));
    expect(screen.getByText("Корень")).toBeDefined();
    expect(screen.getByText("Ответ")).toBeDefined();
    // Ответ вложен в узел корня (второй ul внутри первого li).
    const items = screen.getAllByTestId("comment-item");
    expect(items[0]!.contains(items[1]!)).toBe(true);
  });

  it("новый корневой комментарий появляется сразу после отправки", async () => {
    const api = makeApi({
      postComment: vi.fn().mockResolvedValue({
        comment: makeComment({ id: 5, body: "Свежий" }),
      }),
    });
    mocks.auth = { user, api };
    render(<Comments itemId={10} />);

    fireEvent.change(screen.getByTestId("comment-form-input"), {
      target: { value: "Свежий" },
    });
    fireEvent.click(screen.getByTestId("comment-form-submit"));

    await waitFor(() => expect(screen.getByText("Свежий")).toBeDefined());
    expect(api.postComment).toHaveBeenCalledWith(10, { body: "Свежий", parentId: null });
  });

  it("ответ уходит с parentId и узел вкладывается", async () => {
    const api = makeApi({
      listComments: vi.fn().mockResolvedValue({
        items: [makeComment({ id: 1, body: "Корень" })],
      }),
      postComment: vi.fn().mockResolvedValue({
        comment: makeComment({ id: 2, parentId: 1, depth: 1, body: "Вложенный" }),
      }),
    });
    mocks.auth = { user, api };
    render(<Comments itemId={10} />);

    await waitFor(() => expect(screen.getByText("Корень")).toBeDefined());
    fireEvent.click(screen.getByTestId("reply-button"));
    fireEvent.change(screen.getByTestId("reply-form-input"), {
      target: { value: "Вложенный" },
    });
    fireEvent.click(screen.getByTestId("reply-form-submit"));

    await waitFor(() => expect(screen.getByText("Вложенный")).toBeDefined());
    expect(api.postComment).toHaveBeenCalledWith(10, { body: "Вложенный", parentId: 1 });
    const items = screen.getAllByTestId("comment-item");
    expect(items[0]!.contains(items[1]!)).toBe(true);
  });

  it("удаление своего комментария помечает узел удалённым", async () => {
    const api = makeApi({
      listComments: vi.fn().mockResolvedValue({
        items: [makeComment({ id: 1 })],
      }),
    });
    mocks.auth = { user, api };
    render(<Comments itemId={10} />);

    await waitFor(() => expect(screen.getByTestId("delete-comment")).toBeDefined());
    fireEvent.click(screen.getByTestId("delete-comment"));

    await waitFor(() => expect(screen.getByTestId("comment-deleted")).toBeDefined());
    expect(api.deleteComment).toHaveBeenCalledWith(1);
  });

  it("гостю форма не показывается", async () => {
    mocks.auth = { user: null, api: makeApi() };
    render(<Comments itemId={10} />);
    expect(screen.queryByTestId("comment-form")).toBeNull();
  });
});

describe("ItemActions", () => {
  it("оптимистично ставит голос и принимает ответ сервера", async () => {
    let resolveVote: (v: unknown) => void = () => {};
    const api = makeApi({
      setVote: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveVote = resolve;
        }),
      ),
    });
    mocks.auth = { user, api };
    render(<ItemActions itemId={10} />);
    await waitFor(() => expect(api.getItemSocial).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("vote-up"));
    // Счётчик вырос сразу, не дожидаясь сервера.
    expect(screen.getByTestId("vote-positive").textContent).toBe("1");
    expect(screen.getByTestId("vote-up").getAttribute("aria-pressed")).toBe("true");
    expect(api.setVote).toHaveBeenCalledWith(10, { positive: true });

    resolveVote({
      vote: { itemId: 10, myVote: true, votes: { positive: 42, negative: 1, total: 43 } },
    });
    await waitFor(() => expect(screen.getByTestId("vote-positive").textContent).toBe("42"));
  });

  it("откатывает голос при ошибке сервера", async () => {
    const api = makeApi({
      setVote: vi.fn().mockRejectedValue(new Error("offline")),
    });
    mocks.auth = { user, api };
    render(<ItemActions itemId={10} />);
    await waitFor(() => expect(api.getItemSocial).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("vote-down"));
    expect(screen.getByTestId("vote-negative").textContent).toBe("1");
    await waitFor(() =>
      expect(screen.getByTestId("vote-negative").textContent).toBe("0"),
    );
    expect(screen.getByTestId("vote-down").getAttribute("aria-pressed")).toBe("false");
  });

  it("клик по активному голосу снимает его", async () => {
    const api = makeApi({
      getItemSocial: vi.fn().mockResolvedValue({
        social: makeSocial({ vote: { itemId: 10, myVote: true, votes: { positive: 3, negative: 0, total: 3 } } }),
      }),
      clearVote: vi.fn().mockResolvedValue({
        vote: { itemId: 10, myVote: null, votes: { positive: 2, negative: 0, total: 2 } },
      }),
    });
    mocks.auth = { user, api };
    render(<ItemActions itemId={10} />);
    await waitFor(() => expect(screen.getByTestId("vote-positive").textContent).toBe("3"));

    fireEvent.click(screen.getByTestId("vote-up"));
    await waitFor(() => expect(screen.getByTestId("vote-positive").textContent).toBe("2"));
    expect(api.clearVote).toHaveBeenCalledWith(10);
  });

  it("подписка переключается оптимистично и откатывается при ошибке", async () => {
    const api = makeApi({
      subscribe: vi.fn().mockResolvedValue({ subscription: {} as SubscriptionDto }),
      unsubscribe: vi.fn().mockRejectedValue(new Error("offline")),
    });
    mocks.auth = { user, api };
    render(<ItemActions itemId={10} />);
    await waitFor(() => expect(api.getItemSocial).toHaveBeenCalled());

    const button = screen.getByTestId("subscribe-button");
    expect(button.textContent).toContain("Подписаться");
    fireEvent.click(button);
    // Мгновенно, до ответа сервера.
    expect(screen.getByTestId("subscribe-button").textContent).toContain("Вы подписаны");
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith(10, { notify: true }));

    // Отписка падает → кнопка возвращается в «подписан».
    fireEvent.click(screen.getByTestId("subscribe-button"));
    await waitFor(() => expect(api.unsubscribe).toHaveBeenCalledWith(10));
    await waitFor(() =>
      expect(screen.getByTestId("subscribe-button").textContent).toContain("Вы подписаны"),
    );
  });

  it("гостю показывает приглашение войти", () => {
    mocks.auth = { user: null, api: makeApi() };
    render(<ItemActions itemId={10} />);
    expect(screen.getByTestId("social-login-hint")).toBeDefined();
  });
});
