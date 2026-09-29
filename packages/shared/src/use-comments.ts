/**
 * Комментарии тайтла: загрузка, оптимистичные правки, пагинация «показать ещё».
 *
 * Живёт на сабпути `@zal/shared/react`, а не в основном индексе: главный
 * вход остаётся без единого импорта React, и пакеты без React (worker, api)
 * могут импортировать shared как раньше. Работает с react >=18 — версии
 * приложений (веб 19.3, мобильный 19.2) предоставляются самими приложениями,
 * поэтому react здесь не зависимость, а окружение вызывающего.
 *
 * Хук общий для React DOM и React Native и не знает, как нарисован узел:
 * разметка остаётся за платформой. Сеть приходит инъекцией — адаптером
 * `CommentsApi`, которому структурно удовлетворяет клиент из
 * `@zal/api-client`, поэтому оба приложения передают его без обёрток.
 *
 * Правки оптимистичны с откатом: тело меняется сразу, сервер подтверждает
 * или хук возвращает исходную запись. Новый комментарий тоже появляется
 * сразу — временной копией с отрицательным id, которая исчезает при сбое.
 * Отрицательные id не пересекаются с серверными, поэтому дерево и дедуп
 * их не путают.
 */
import type { CommentAuthor, CommentDto } from "@zal/api-client";
import * as React from "react";
import {
  type CommentsApi,
  commentsReducer,
  initialCommentsState,
} from "./comments-state";

export type { CommentsApi, CommentsPage } from "./comments-state";

export interface UseCommentsOptions {
  /**
   * Автор оптимистичной публикации: залогиненный пользователь. Без него
   * новый комментарий появляется только после ответа сервера — правки и
   * удаления оптимистичны всегда.
   */
  author?: CommentAuthor | null;
}

export interface UseCommentsResult {
  comments: CommentDto[];
  total: number;
  nextOffset: number | null;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** Отклоняется при сбое — форма может не очищать текст. */
  add: (parentId: number | null, body: string) => Promise<void>;
  /** Отклоняется при сбое — форма может не очищать текст. */
  edit: (commentId: number, body: string) => Promise<void>;
  /** Отклоняется при сбое; откат пометки «удалён» уже сделан. */
  remove: (commentId: number) => Promise<void>;
  /** Ошибку кладёт в state.error и не отклоняется: кнопка fire-and-forget. */
  loadMore: () => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useComments(
  api: CommentsApi | null | undefined,
  itemId: number,
  opts: UseCommentsOptions = {},
): UseCommentsResult {
  const [state, dispatch] = React.useReducer(commentsReducer, initialCommentsState);
  const { author } = opts;
  // Временные id: отрицательные, чтобы не пересекаться с серверными.
  const tempSeq = React.useRef(0);
  // Снимок списка для отката: колбэки переживают рендер, замыкание на
  // state.list внутри них устаревает.
  const listRef = React.useRef<CommentDto[]>(state.list);
  React.useEffect(() => {
    listRef.current = state.list;
  });

  React.useEffect(() => {
    if (!api) return;
    let cancelled = false;
    dispatch({ type: "loadStarted" });
    api.listComments(itemId).then(
      (page) => {
        if (!cancelled) {
          dispatch({
            type: "loadSucceeded",
            items: page.items,
            nextOffset: page.nextOffset,
            total: page.total,
          });
        }
      },
      (err: unknown) => {
        if (!cancelled) dispatch({ type: "loadFailed", error: messageOf(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);

  const add = React.useCallback(
    async (parentId: number | null, body: string) => {
      if (!api) return;
      const tempId = --tempSeq.current;
      const optimistic = author != null;
      if (optimistic) {
        dispatch({ type: "addStarted", tempId, itemId, parentId, body, author });
      }
      try {
        const res = await api.postComment(itemId, { body, parentId });
        dispatch(
          optimistic
            ? { type: "addSucceeded", tempId, comment: res.comment }
            : { type: "appended", comment: res.comment },
        );
      } catch (err) {
        if (optimistic) {
          dispatch({ type: "addFailed", tempId, parentId, error: messageOf(err) });
        }
        throw err;
      }
    },
    [api, itemId, author],
  );

  const edit = React.useCallback(
    async (commentId: number, body: string) => {
      if (!api) return;
      const original = listRef.current.find((c) => c.id === commentId) ?? null;
      dispatch({ type: "editStarted", id: commentId, body });
      try {
        const res = await api.editComment(commentId, { body });
        dispatch({ type: "editSucceeded", comment: res.comment });
      } catch (err) {
        dispatch({ type: "editFailed", original, error: messageOf(err) });
        throw err;
      }
    },
    [api],
  );

  const remove = React.useCallback(
    async (commentId: number) => {
      if (!api) return;
      const original = listRef.current.find((c) => c.id === commentId) ?? null;
      dispatch({ type: "removeStarted", id: commentId });
      try {
        await api.deleteComment(commentId);
      } catch (err) {
        dispatch({ type: "removeFailed", original, error: messageOf(err) });
        throw err;
      }
    },
    [api],
  );

  const loadMore = React.useCallback(async () => {
    if (!api || state.nextOffset == null || state.loadingMore) return;
    dispatch({ type: "moreStarted" });
    try {
      const page = await api.listComments(itemId, { offset: state.nextOffset });
      dispatch({ type: "moreSucceeded", items: page.items, nextOffset: page.nextOffset });
    } catch (err) {
      dispatch({ type: "moreFailed", error: messageOf(err) });
    }
  }, [api, itemId, state.nextOffset, state.loadingMore]);

  return {
    comments: state.list,
    total: state.total,
    nextOffset: state.nextOffset,
    loaded: state.loaded,
    loading: state.loading,
    loadingMore: state.loadingMore,
    error: state.error,
    add,
    edit,
    remove,
    loadMore,
  };
}
