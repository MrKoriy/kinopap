/**
 * Состояние комментариев тайтла и его редьюсер — чистое ядро хука
 * `useComments`.
 *
 * Вынесено из хука не ради архитектуры. Логика оптимистичных правок и
 * откатов — ровно та, что ломается незаметно, а рендер-инфраструктуры в
 * пакете нет; ядро проверяется обычными тестами без React. Поэтому здесь
 * нет ни одного импорта React: хук в `./use-comments` владеет эффектами
 * и сетью, редьюсер — списком, дедупом и откатами.
 */
import type { CommentAuthor, CommentDto } from "@zal/api-client";

/** Страница комментариев: корневые ветки целиком со всеми ответами. */
export interface CommentsPage {
  items: CommentDto[];
  /** Смещение следующей страницы веток; null — всё загружено. */
  nextOffset: number | null;
  /** Всего корневых веток у тайтла. */
  total: number;
}

/**
 * Минимум API, нужный комментариям: загрузка, публикация, правка, удаление.
 * Структурно ему удовлетворяет клиент `@zal/api-client` — приложения
 * передают его без обёрток, а общий хук не привязывается к конкретному
 * клиенту и не тянет новых зависимостей.
 */
export interface CommentsApi {
  listComments(itemId: number, opts?: { limit?: number; offset?: number }): Promise<CommentsPage>;
  postComment(
    itemId: number,
    input: { body: string; parentId: number | null },
  ): Promise<{ comment: CommentDto }>;
  editComment(commentId: number, input: { body: string }): Promise<{ comment: CommentDto }>;
  deleteComment(commentId: number): Promise<{ ok: boolean }>;
}

export interface CommentsState {
  list: CommentDto[];
  nextOffset: number | null;
  total: number;
  /** Первая загрузка завершилась (успехом или ошибкой): можно решать, пусто ли. */
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export const initialCommentsState: CommentsState = {
  list: [],
  nextOffset: null,
  total: 0,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: null,
};

export type CommentsAction =
  | { type: "loadStarted" }
  | { type: "loadSucceeded"; items: CommentDto[]; nextOffset: number | null; total: number }
  | { type: "loadFailed"; error: string }
  | { type: "moreStarted" }
  | { type: "moreSucceeded"; items: CommentDto[]; nextOffset: number | null }
  | { type: "moreFailed"; error: string }
  | {
      type: "addStarted";
      tempId: number;
      itemId: number;
      parentId: number | null;
      body: string;
      author: CommentAuthor;
    }
  | { type: "addSucceeded"; tempId: number; comment: CommentDto }
  | { type: "addFailed"; tempId: number; parentId: number | null; error: string }
  | { type: "appended"; comment: CommentDto }
  | { type: "editStarted"; id: number; body: string }
  | { type: "editSucceeded"; comment: CommentDto }
  | { type: "editFailed"; original: CommentDto | null; error: string }
  | { type: "removeStarted"; id: number }
  | { type: "removeFailed"; original: CommentDto | null; error: string };

/** Слияние страниц без дублей: гонки пагинации не должны двоить узлы. */
function mergeUnique(prev: CommentDto[], incoming: CommentDto[]): CommentDto[] {
  const seen = new Set(prev.map((c) => c.id));
  return [...prev, ...incoming.filter((c) => !seen.has(c.id))];
}

export function commentsReducer(state: CommentsState, action: CommentsAction): CommentsState {
  switch (action.type) {
    case "loadStarted":
      return { ...state, loading: true, error: null };
    case "loadSucceeded": {
      // Страница может прийти, пока оптимистичная публикация ещё в списке:
      // временные копии (id < 0) обязаны пережить загрузку, иначе addSucceeded
      // не найдёт tempId и комментарий потеряется. Корни из ожидаемых копий
      // прибавляются к серверному total, чтобы счётчик не занижался.
      const pending = state.list.filter((c) => c.id < 0);
      const pendingRoots = pending.filter((c) => c.parentId == null).length;
      return {
        ...state,
        list: pending.length > 0 ? mergeUnique(action.items, pending) : action.items,
        nextOffset: action.nextOffset,
        total: action.total + pendingRoots,
        loaded: true,
        loading: false,
        loadingMore: false,
        error: null,
      };
    }
    case "loadFailed":
      // loaded ставится и при ошибке — так делал веб: карточка должна
      // отличать «пусто» от «ещё не спросили».
      return { ...state, loaded: true, loading: false, error: action.error };
    case "moreStarted":
      return { ...state, loadingMore: true };
    case "moreSucceeded":
      return {
        ...state,
        list: mergeUnique(state.list, action.items),
        nextOffset: action.nextOffset,
        loadingMore: false,
        error: null,
      };
    case "moreFailed":
      return { ...state, loadingMore: false, error: action.error };
    case "addStarted": {
      const parent =
        action.parentId == null
          ? undefined
          : state.list.find((c) => c.id === action.parentId);
      const now = new Date().toISOString();
      // Временная копия с отрицательным id: серверные id положительные,
      // дерево и дедуп их не путают, откат — просто удалить запись.
      const temp: CommentDto = {
        id: action.tempId,
        itemId: action.itemId,
        parentId: action.parentId,
        depth: parent ? parent.depth + 1 : 0,
        body: action.body,
        deleted: false,
        author: action.author,
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...state,
        list: [...state.list, temp],
        total: action.parentId == null ? state.total + 1 : state.total,
      };
    }
    case "addSucceeded": {
      // Серверная копия занимает место временной. Если она уже в списке
      // (страница догрузила её гонкой) — временная просто уходит.
      const exists = state.list.some((c) => c.id === action.comment.id);
      return {
        ...state,
        list: exists
          ? state.list.filter((c) => c.id !== action.tempId)
          : state.list.map((c) => (c.id === action.tempId ? action.comment : c)),
      };
    }
    case "addFailed":
      return {
        ...state,
        list: state.list.filter((c) => c.id !== action.tempId),
        total: action.parentId == null ? state.total - 1 : state.total,
        error: action.error,
      };
    case "appended": {
      if (state.list.some((c) => c.id === action.comment.id)) return state;
      return {
        ...state,
        list: [...state.list, action.comment],
        total: action.comment.parentId == null ? state.total + 1 : state.total,
      };
    }
    case "editStarted":
      return {
        ...state,
        list: state.list.map((c) => (c.id === action.id ? { ...c, body: action.body } : c)),
      };
    case "editSucceeded":
      return {
        ...state,
        list: state.list.map((c) => (c.id === action.comment.id ? action.comment : c)),
        error: null,
      };
    case "editFailed": {
      const original = action.original;
      return {
        ...state,
        list: original
          ? state.list.map((c) => (c.id === original.id ? original : c))
          : state.list,
        error: action.error,
      };
    }
    case "removeStarted":
      // Узел остаётся в дереве с пометкой «удалён» — так делают оба клиента.
      return {
        ...state,
        list: state.list.map((c) => (c.id === action.id ? { ...c, deleted: true, body: "" } : c)),
      };
    case "removeFailed": {
      const original = action.original;
      return {
        ...state,
        list: original
          ? state.list.map((c) => (c.id === original.id ? original : c))
          : state.list,
        error: action.error,
      };
    }
  }
}
