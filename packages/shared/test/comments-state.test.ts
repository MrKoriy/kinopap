/**
 * Редьюсер комментариев — чистое ядро хука useComments: оптимистичные
 * правки, откаты, дедуп страниц. Тестируется без React (рендер-инфраструкции
 * в пакете нет, а ломается на таких вещах именно логика состояния).
 */
import type { CommentDto } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import {
  type CommentsAction,
  type CommentsState,
  commentsReducer,
  initialCommentsState,
} from "../src/comments-state";

function comment(over: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 1,
    itemId: 10,
    parentId: null,
    depth: 0,
    body: "текст",
    deleted: false,
    author: { id: 7, name: "Юля" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function reduce(state: CommentsState, ...actions: CommentsAction[]): CommentsState {
  return actions.reduce(commentsReducer, state);
}

describe("загрузка", () => {
  it("успех кладёт страницу и снимает loading", () => {
    const items = [comment({ id: 1 }), comment({ id: 2 })];
    const state = reduce(
      initialCommentsState,
      { type: "loadStarted" },
      { type: "loadSucceeded", items, nextOffset: 20, total: 5 },
    );
    expect(state).toMatchObject({
      list: items,
      nextOffset: 20,
      total: 5,
      loaded: true,
      loading: false,
      error: null,
    });
  });

  it("ошибка ставит loaded (поведение веба) и сохраняет прошлый список", () => {
    const withList = reduce(
      initialCommentsState,
      { type: "loadSucceeded", items: [comment({ id: 1 })], nextOffset: null, total: 1 },
    );
    const state = reduce(withList, { type: "loadFailed", error: "сеть" });
    expect(state.loaded).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.error).toBe("сеть");
    expect(state.list).toHaveLength(1);
  });

  it("новая загрузка сбрасывает прошлую ошибку", () => {
    const failed = reduce(initialCommentsState, { type: "loadFailed", error: "сеть" });
    const state = reduce(failed, { type: "loadStarted" });
    expect(state.error).toBeNull();
    expect(state.loading).toBe(true);
  });
});

describe("пагинация", () => {
  it("страница дозагрузки сливается без дублей", () => {
    const first = reduce(
      initialCommentsState,
      { type: "loadSucceeded", items: [comment({ id: 1 }), comment({ id: 2 })], nextOffset: 2, total: 4 },
    );
    const state = reduce(first, {
      type: "moreSucceeded",
      // Гонка: серверная копия только что добавленного ответа.
      items: [comment({ id: 2 }), comment({ id: 3 })],
      nextOffset: null,
    });
    expect(state.list.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(state.nextOffset).toBeNull();
    expect(state.loadingMore).toBe(false);
  });

  it("ошибка дозагрузки не портит список", () => {
    const first = reduce(
      initialCommentsState,
      { type: "loadSucceeded", items: [comment({ id: 1 })], nextOffset: 2, total: 2 },
      { type: "moreStarted" },
    );
    const state = reduce(first, { type: "moreFailed", error: "сеть" });
    expect(state.loadingMore).toBe(false);
    expect(state.error).toBe("сеть");
    expect(state.list).toHaveLength(1);
  });
});

describe("оптимистичная публикация", () => {
  const root = reduce(
    initialCommentsState,
    { type: "loadSucceeded", items: [comment({ id: 5 })], nextOffset: null, total: 1 },
  );

  it("временный корень появляется сразу и поднимает total", () => {
    const state = reduce(root, {
      type: "addStarted",
      tempId: -1,
      itemId: 10,
      parentId: null,
      body: "новый",
      author: { id: 7, name: "Юля" },
    });
    expect(state.list.map((c) => c.id)).toEqual([5, -1]);
    expect(state.total).toBe(2);
    expect(state.list[1]).toMatchObject({ depth: 0, body: "новый", deleted: false });
  });

  it("временный ответ считается от глубины родителя и total не трогает", () => {
    const thread = reduce(
      root,
      {
        type: "addStarted",
        tempId: -1,
        itemId: 10,
        parentId: 5,
        body: "ответ",
        author: { id: 7, name: "Юля" },
      },
    );
    expect(thread.list[1]).toMatchObject({ id: -1, parentId: 5, depth: 1 });
    expect(thread.total).toBe(1);
  });

  it("серверная копия занимает место временной", () => {
    const state = reduce(
      root,
      {
        type: "addStarted",
        tempId: -1,
        itemId: 10,
        parentId: null,
        body: "новый",
        author: { id: 7, name: "Юля" },
      },
      { type: "addSucceeded", tempId: -1, comment: comment({ id: 42, body: "новый" }) },
    );
    expect(state.list.map((c) => c.id)).toEqual([5, 42]);
    expect(state.total).toBe(2);
  });

  it("серверная копия, уже приехавшая страницей, убирает только временную", () => {
    const state = reduce(
      root,
      {
        type: "addStarted",
        tempId: -1,
        itemId: 10,
        parentId: null,
        body: "новый",
        author: { id: 7, name: "Юля" },
      },
      { type: "addSucceeded", tempId: -1, comment: comment({ id: 5 }) },
    );
    expect(state.list.map((c) => c.id)).toEqual([5]);
  });

  it("сбой убирает временную копию и возвращает total", () => {
    const state = reduce(
      root,
      {
        type: "addStarted",
        tempId: -1,
        itemId: 10,
        parentId: null,
        body: "новый",
        author: { id: 7, name: "Юля" },
      },
      { type: "addFailed", tempId: -1, parentId: null, error: "403" },
    );
    expect(state.list.map((c) => c.id)).toEqual([5]);
    expect(state.total).toBe(1);
    expect(state.error).toBe("403");
  });

  it("страница, пришедшая до ответа на публикацию, не теряет временную копию", () => {
    // Гонка «первая загрузка vs сабмит»: temp уже в списке, когда приезжает
    // страница. Раньше loadSucceeded затирал список и addSucceeded терял
    // комментарий.
    const state = reduce(
      initialCommentsState,
      { type: "loadStarted" },
      {
        type: "addStarted",
        tempId: -1,
        itemId: 10,
        parentId: null,
        body: "новый",
        author: { id: 7, name: "Юля" },
      },
      { type: "loadSucceeded", items: [comment({ id: 5 })], nextOffset: null, total: 1 },
    );
    expect(state.list.map((c) => c.id)).toEqual([5, -1]);
    expect(state.total).toBe(2);
    expect(state.loaded).toBe(true);

    const done = reduce(state, {
      type: "addSucceeded",
      tempId: -1,
      comment: comment({ id: 42, body: "новый" }),
    });
    expect(done.list.map((c) => c.id)).toEqual([5, 42]);
  });

  it("неоптимистичная публикация дописывается без дубля", () => {
    const state = reduce(root, { type: "appended", comment: comment({ id: 42 }) });
    expect(state.list.map((c) => c.id)).toEqual([5, 42]);
    expect(state.total).toBe(2);

    const dup = reduce(state, { type: "appended", comment: comment({ id: 42 }) });
    expect(dup).toBe(state);
  });
});

describe("оптимистичная правка", () => {
  const base = reduce(
    initialCommentsState,
    { type: "loadSucceeded", items: [comment({ id: 5, body: "было" })], nextOffset: null, total: 1 },
  );

  it("тело меняется сразу, сервер подтверждает своей копией", () => {
    const state = reduce(
      base,
      { type: "editStarted", id: 5, body: "стало" },
      {
        type: "editSucceeded",
        comment: comment({ id: 5, body: "стало", updatedAt: "2026-02-01T00:00:00.000Z" }),
      },
    );
    expect(state.list[0]?.body).toBe("стало");
    expect(state.list[0]?.updatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(state.error).toBeNull();
  });

  it("сбой возвращает исходную запись", () => {
    const state = reduce(
      base,
      { type: "editStarted", id: 5, body: "стало" },
      { type: "editFailed", original: comment({ id: 5, body: "было" }), error: "403" },
    );
    expect(state.list[0]?.body).toBe("было");
    expect(state.error).toBe("403");
  });
});

describe("оптимистичное удаление", () => {
  const base = reduce(
    initialCommentsState,
    { type: "loadSucceeded", items: [comment({ id: 5, body: "текст" })], nextOffset: null, total: 1 },
  );

  it("узел помечается удалённым и остаётся в дереве", () => {
    const state = reduce(base, { type: "removeStarted", id: 5 });
    expect(state.list[0]).toMatchObject({ id: 5, deleted: true, body: "" });
  });

  it("сбой снимает пометку и возвращает тело", () => {
    const state = reduce(
      base,
      { type: "removeStarted", id: 5 },
      { type: "removeFailed", original: comment({ id: 5, body: "текст" }), error: "500" },
    );
    expect(state.list[0]).toMatchObject({ deleted: false, body: "текст" });
    expect(state.error).toBe("500");
  });
});
