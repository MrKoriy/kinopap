/**
 * Типизированный HTTP-клиент API «Зал».
 * Общий для web и mobile: пара fetch + базовый URL, дедлайн на каждый
 * запрос (по умолчанию 30с, повисший fetch больше не ждёт вечно), один
 * ретрай GET при сетевом сбое, ошибки — в ApiError.
 */

import { z } from "zod";
import {
  type AuthResponse,
  authResponseSchema,
  type ChangePasswordInput,
  changePasswordSchema,
  type LoginInput,
  loginSchema,
  logoutResponseSchema,
  meResponseSchema,
  type RegisterInput,
  refreshResponseSchema,
  refreshSchema,
  registerSchema,
  type Tokens,
  type User,
} from "./auth";
import {
  type CatalogFilters,
  countriesResponseSchema,
  genresResponseSchema,
  type ItemDetail,
  type ItemPage,
  itemDetailSchema,
  itemPageSchema,
  itemsSummaryResponseSchema,
  type MediaLinks,
  type MediaTracks,
  mediaLinksSchema,
  mediaTracksSchema,
  typesResponseSchema,
} from "./catalog";
import type { ApiErrorBody, ItemType } from "./common";
import { apiErrorSchema, okResponseSchema } from "./common";
import {
  type IngestRequest,
  ingestRequestSchema,
  ingestResponseSchema,
  type ProgressPut,
  progressListResponseSchema,
  progressPutSchema,
  progressResponseSchema,
} from "./ingest";
import {
  clearHistoryResponseSchema,
  favoriteListResponseSchema,
  favoriteResponseSchema,
  historyListResponseSchema,
  itemProgressResponseSchema,
  profileOverviewResponseSchema,
  type UserListCreate,
  type UserListUpdate,
  userListCreateSchema,
  userListDetailResponseSchema,
  userListListResponseSchema,
  userListResponseSchema,
  userListUpdateSchema,
} from "./profile";
import {
  type CommentPost,
  type CommentPut,
  commentListResponseSchema,
  commentPostSchema,
  commentPutSchema,
  commentResponseSchema,
  itemSocialResponseSchema,
  newEpisodesResponseSchema,
  type SubscriptionPut,
  subscriptionListResponseSchema,
  subscriptionPutSchema,
  subscriptionResponseSchema,
  type VotePut,
  votePutSchema,
  voteResponseSchema,
} from "./social";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(`${status}: ${body.error.message}`);
    this.name = "ApiError";
  }
}

/**
 * Запрос не уложился в дедлайн: fetch оборван таймаутом, а не внешним
 * signal. Код "timeout" — как у ошибок API, чтобы вызывающий различал
 * «не дождались» и «не доехало». Это ApiError: обработчики ошибок не
 * обязаны знать про транспортный слой отдельно.
 */
export class ApiTimeoutError extends ApiError {
  constructor(timeoutMs: number) {
    super(0, { error: { code: "timeout", message: `Запрос не уложился в ${timeoutMs} мс` } });
    this.name = "ApiTimeoutError";
  }
}

/** Дедлайн запроса по умолчанию: повисший fetch без лимита ждал вечно. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Веб: "include" — httpOnly-cookie с refresh-токеном ходит с запросами. */
  credentials?: "include" | "same-origin" | "omit";
  /**
   * Дедлайн каждого запроса (мс), если метод не задал свой. 0 отключает.
   * Холодные media-links и опрос дорожек берут щедрый лимит — см. методы.
   */
  timeoutMs?: number;
  /**
   * Вызывается при 401 от защищённого запроса — шанс сделать refresh.
   *
   * `false` означает «сессия кончилась»: повторять запрос не нужно, он всё
   * равно получит 401, и клиент падает с исходным телом ошибки. `undefined`
   * (или `true`) сохраняет прежнее поведение — повтор после обработчика,
   * потому что старый контракт не давал способа сообщить о провале. Готовый
   * обработчик собирает `createTokenRefresher` из `./refresh`.
   */
  onUnauthorized?: () => Promise<boolean | undefined>;
}

/** CatalogFilters → query-строка (формат API 1.3). */
export function filtersToQuery(f: CatalogFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.type) q.type = f.type;
  if (f.title) q.title = f.title;
  if (f.genreIds?.length) q.genre = f.genreIds.join(",");
  if (f.countryIds?.length) q.country = f.countryIds.join(",");
  if (f.yearFrom != null) {
    q.year =
      f.yearTo != null && f.yearTo !== f.yearFrom
        ? `${f.yearFrom}-${f.yearTo}`
        : String(f.yearFrom);
  } else if (f.yearTo != null) {
    q.year = `-${f.yearTo}`;
  }
  if (f.letter) q.letter = f.letter;
  if (f.actor) q.actor = f.actor;
  if (f.director) q.director = f.director;
  if (f.sort) {
    q.sort = f.sort.dir === "desc" ? `${f.sort.field}-` : f.sort.field;
  }
  if (f.cursor) q.cursor = f.cursor;
  q.limit = String(f.limit);
  return q;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Статические timeout/any есть не у всех типов AbortSignal (старые
 * объявления React Native знают AbortSignal без них), поэтому достаются
 * через необязательные слоты, а рантайм проверяется на месте. Где их нет —
 * ручной фолбэк на подписку.
 */
interface AbortSignalStatics {
  timeout?: (ms: number) => AbortSignal;
  any?: (signals: readonly AbortSignal[]) => AbortSignal;
}

const signalStatics = AbortSignal as typeof AbortSignal & AbortSignalStatics;

/** Внешний signal и дедлайн, сведённые в один signal. */
/**
 * `AbortController.abort(reason)` есть в Node 17.2+/современных браузерах, но
 * в lib-типах React Native он объявлен без аргумента — вызываем через
 * расширенную сигнатуру, а на старых рантаймах откатываемся на abort().
 */
function abortWithReason(ctrl: AbortController, reason: unknown): void {
  try {
    (ctrl.abort as (reason?: unknown) => void).call(ctrl, reason);
  } catch {
    ctrl.abort();
  }
}

function requestSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  let deadline: AbortSignal | undefined;
  if (timeoutMs > 0) {
    if (typeof signalStatics.timeout === "function") {
      deadline = signalStatics.timeout(timeoutMs);
    } else {
      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        abortWithReason(ctrl, new DOMException("TimeoutError", "TimeoutError"));
      }, timeoutMs);
      // Node: let timer not keep process alive
      if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref!();
      }
      deadline = ctrl.signal;
    }
  }
  if (external == null) return deadline;
  if (deadline == null) return external;
  if (typeof signalStatics.any === "function") return signalStatics.any([external, deadline]);
  // AbortSignal.any нет — зажигаем первый же аборт из двух.
  const controller = new AbortController();
  for (const s of [external, deadline]) {
    if (s.aborted) {
      abortWithReason(controller, (s as unknown as { reason?: unknown }).reason);
      return controller.signal;
    }
    s.addEventListener("abort", () => abortWithReason(controller, (s as unknown as { reason?: unknown }).reason), { once: true });
  }
  return controller.signal;
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * AbortError превращается в таймаут-ошибку, только если внешнего signal не
 * было: отмена вызывающим — не наша ошибка, и летит наверх как есть.
 */
function toTransportError(
  err: unknown,
  external: AbortSignal | undefined,
  timeoutMs: number,
): unknown {
  if (!isAbortError(err)) return err;
  if (external?.aborted) return err;
  return new ApiTimeoutError(timeoutMs);
}

export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  let accessToken: string | null = null;

  async function request<T>(
    path: string,
    schema: { parse: (v: unknown) => T },
    init: {
      method?: string;
      body?: unknown;
      query?: Record<string, unknown>;
      auth?: boolean;
      retryOn401?: boolean;
      /** keepalive: запрос выживает выгрузку страницы (запись прогресса). */
      keepalive?: boolean;
      /** Внешняя отмена: unmount экрана, навигация, роутер. */
      signal?: AbortSignal;
      /** Дедлайн запроса (мс); 0 — без лимита. Иначе клиентский или 30с. */
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.auth && accessToken) headers.authorization = `Bearer ${accessToken}`;

    const method = init.method ?? "GET";
    const timeoutMs = init.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const doRequest = () =>
      doFetch(buildUrl(opts.baseUrl, path, init.query), {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        keepalive: init.keepalive ?? false,
        credentials: opts.credentials,
        signal: requestSignal(init.signal, timeoutMs),
      });

    let res: Response;
    try {
      res = await doRequest();
    } catch (err) {
      // Один ретрай при сетевом сбое (fetch reject, не HTTP-ошибка) — только
      // GET: повтор POST мог бы задвоить его эффект, а после внешней отмены
      // или таймаута повтор никому не нужен.
      if (method !== "GET" || init.signal?.aborted || isAbortError(err)) {
        throw toTransportError(err, init.signal, timeoutMs);
      }
      try {
        res = await doRequest();
      } catch (retryErr) {
        throw toTransportError(retryErr, init.signal, timeoutMs);
      }
    }

    if (res.status === 401 && init.auth && init.retryOn401 !== false && opts.onUnauthorized) {
      // Явный отказ от повтора экономит запрос: после неудачной ротации второй
      // заход гарантированно получает тот же 401, и вызывающий ждал бы лишний
      // круг до сети ради того же ApiError.
      if ((await opts.onUnauthorized()) !== false) {
        return request(path, schema, { ...init, retryOn401: false });
      }
    }

    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const parsed = apiErrorSchema.safeParse(json);
      throw new ApiError(
        res.status,
        parsed.success
          ? parsed.data
          : { error: { code: "unknown", message: res.statusText } },
      );
    }
    return schema.parse(json);
  }

  const client = {
    get accessToken() {
      return accessToken;
    },
    setToken(token: string | null) {
      accessToken = token;
    },

    health: () => request("/healthz", okResponseSchema),

    /* auth */
    register: (input: RegisterInput) => {
      registerSchema.parse(input);
      return request("/v1/auth/register", authResponseSchema, {
        method: "POST",
        body: input,
      });
    },
    login: (input: LoginInput) => {
      loginSchema.parse(input);
      return request("/v1/auth/login", authResponseSchema, {
        method: "POST",
        body: input,
      });
    },
    /**
     * Ротация refresh. Веб шлёт пустое тело — токен в httpOnly-cookie;
     * мобила передаёт refreshToken (Keychain).
     */
    refresh: (input?: { refreshToken: string }) => {
      if (input) refreshSchema.parse(input);
      return request("/v1/auth/refresh", refreshResponseSchema, {
        method: "POST",
        body: input,
      });
    },
    logout: (input?: { refreshToken: string }) => {
      if (input) refreshSchema.parse(input);
      return request("/v1/auth/logout", logoutResponseSchema, {
        method: "POST",
        body: input,
      });
    },
    me: () => request("/v1/auth/me", meResponseSchema, { auth: true }),
    /**
     * Смена пароля. Сервер отзывает все refresh-токены пользователя (выход
     * на остальных устройствах) и выдаёт свежую пару для этой сессии.
     */
    changePassword: (input: ChangePasswordInput) => {
      changePasswordSchema.parse(input);
      return request("/v1/auth/password", authResponseSchema, {
        method: "POST",
        body: input,
        auth: true,
      });
    },

    /* catalog */
    listItems: (filters: CatalogFilters) =>
      request("/v1/items", itemPageSchema, {
        query: filtersToQuery(filters) as Record<string, unknown>,
      }),
    searchItems: (
      q: { q: string; type?: ItemType; field?: "title" | "director" | "cast"; limit?: number },
      opts?: { auth?: boolean },
    ) =>
      request("/v1/items/search", itemPageSchema, {
        query: q,
        auth: opts?.auth ?? !!accessToken,
      }),
    /** Подсказки по мере ввода: локальный каталог, до 8 тайтлов, без discovery. */
    suggestItems: (q: string, type?: ItemType) =>
      request("/v1/items/suggest", itemPageSchema, { query: { q, type, limit: 8 } }),
    getItem: (id: number) => request(`/v1/items/${id}`, itemDetailSchema),
    /** Батч карточек по id: ленты «продолжить смотреть» берут всё одним
     * запросом вместо getItem на каждую запись прогресса. */
    getItemsSummary: (ids: number[]) =>
      request("/v1/items/summary", itemsSummaryResponseSchema, {
        query: { ids: ids.join(",") },
      }),
    getMediaLinks: (itemId: number, mediaId: number) =>
      request(`/v1/items/${itemId}/media-links`, mediaLinksSchema, {
        query: { mid: mediaId },
        // Ссылки на поток выдаются только участникам клуба.
        auth: true,
        // Холодный резолв ходит в rutor/AniLibria/TorrServer и занимает
        // десятки секунд — дефолтный дедлайн его срезал бы. Веб-обёртка
        // SSR держит для этого запроса те же 45с.
        timeoutMs: 45_000,
      }),
    /**
     * Ленивые аудио-дорожки прогретого релиза: подтягиваются фоном, пока
     * плеер уже играет — gst-проба на холодных пирах занимает до 45с и не
     * должна блокировать старт воспроизведения.
     */
    getMediaTracks: (itemId: number, mediaId: number) =>
      request(`/v1/items/${itemId}/media-tracks`, mediaTracksSchema, {
        query: { mid: mediaId },
        auth: true,
        timeoutMs: 45_000,
      }),
    getSimilar: (id: number) =>
      request(`/v1/items/${id}/similar`, itemPageSchema),
    getShortcut: (kind: "fresh" | "hot" | "popular", q?: Record<string, unknown>) =>
      request(`/v1/items/${kind}`, itemPageSchema, { query: q }),

    /* ingest */
    ingest: (input: IngestRequest) => {
      ingestRequestSchema.parse(input);
      return request("/v1/ingest", ingestResponseSchema, {
        method: "POST",
        body: input,
        auth: true,
      });
    },
    getIngestJob: (id: number) =>
      request(`/v1/ingest/${id}`, ingestResponseSchema, { auth: true }),

    /* progress */
    getProgress: (mediaId: number) =>
      request(`/v1/progress/${mediaId}`, progressResponseSchema, { auth: true }),
    saveProgress: (mediaId: number, input: ProgressPut) => {
      progressPutSchema.parse(input);
      return request(`/v1/progress/${mediaId}`, progressResponseSchema, {
        method: "PUT",
        body: input,
        auth: true,
        // Прогресс пишется и из pagehide: браузер обрывает обычный fetch,
        // keepalive (тело < 64КБ) доносит запись до API.
        keepalive: true,
      });
    },
    listProgress: () =>
      request("/v1/progress", progressListResponseSchema, { auth: true }),

    /* profile */
    getProfileOverview: () =>
      request("/v1/profile/overview", profileOverviewResponseSchema, { auth: true }),
    /** Прогресс всех media тайтла — галочки по сериям и активный сезон. */
    getItemProgress: (itemId: number) =>
      request(`/v1/items/${itemId}/progress`, itemProgressResponseSchema, { auth: true }),

    /* favorites */
    listFavorites: () =>
      request("/v1/favorites", favoriteListResponseSchema, { auth: true }),
    getFavorite: (itemId: number) =>
      request(`/v1/favorites/${itemId}`, favoriteResponseSchema, { auth: true }),
    getFavoritesBatch: (ids: number[]) =>
      request("/v1/favorites/batch", z.object({ favorites: z.array(z.number().int()) }), {
        query: { ids: ids.join(",") },
        auth: true,
      }),
    addFavorite: (itemId: number) =>
      request(`/v1/favorites/${itemId}`, favoriteResponseSchema, {
        method: "PUT",
        auth: true,
      }),
    removeFavorite: (itemId: number) =>
      request(`/v1/favorites/${itemId}`, favoriteResponseSchema, {
        method: "DELETE",
        auth: true,
      }),

    /* lists (подборки) */
    listLists: () => request("/v1/lists", userListListResponseSchema, { auth: true }),
    getListsMembership: (itemId: number) =>
      request("/v1/lists/membership", z.object({ lists: z.array(z.number().int()) }), {
        query: { itemId },
        auth: true,
      }),
    createList: (input: UserListCreate) => {
      userListCreateSchema.parse(input);
      return request("/v1/lists", userListResponseSchema, {
        method: "POST",
        body: input,
        auth: true,
      });
    },
    getList: (listId: number) =>
      request(`/v1/lists/${listId}`, userListDetailResponseSchema, { auth: true }),
    updateList: (listId: number, patch: UserListUpdate) => {
      userListUpdateSchema.parse(patch);
      return request(`/v1/lists/${listId}`, userListResponseSchema, {
        method: "PATCH",
        body: patch,
        auth: true,
      });
    },
    deleteList: (listId: number) =>
      request(`/v1/lists/${listId}`, okResponseSchema, {
        method: "DELETE",
        auth: true,
      }),
    addToList: (listId: number, itemId: number) =>
      request(`/v1/lists/${listId}/items/${itemId}`, userListDetailResponseSchema, {
        method: "PUT",
        auth: true,
      }),
    removeFromList: (listId: number, itemId: number) =>
      request(`/v1/lists/${listId}/items/${itemId}`, userListDetailResponseSchema, {
        method: "DELETE",
        auth: true,
      }),

    /* history */
    listHistory: (opts?: { limit?: number; offset?: number }) =>
      request("/v1/history", historyListResponseSchema, {
        query: { limit: opts?.limit, offset: opts?.offset },
        auth: true,
      }),
    clearHistory: () =>
      request("/v1/history", clearHistoryResponseSchema, {
        method: "DELETE",
        auth: true,
      }),
    deleteHistoryEntry: (mediaId: number) =>
      request(`/v1/history/${mediaId}`, okResponseSchema, {
        method: "DELETE",
        auth: true,
      }),

    /* social */
    getItemSocial: (itemId: number) =>
      request(`/v1/items/${itemId}/social`, itemSocialResponseSchema, { auth: true }),
    listComments: (itemId: number, opts?: { limit?: number; offset?: number }) =>
      request(`/v1/items/${itemId}/comments`, commentListResponseSchema, {
        query: { limit: opts?.limit, offset: opts?.offset },
      }),
    postComment: (itemId: number, input: CommentPost) => {
      commentPostSchema.parse(input);
      return request(`/v1/items/${itemId}/comments`, commentResponseSchema, {
        method: "POST",
        body: input,
        auth: true,
      });
    },
    editComment: (commentId: number, input: CommentPut) => {
      commentPutSchema.parse(input);
      return request(`/v1/comments/${commentId}`, commentResponseSchema, {
        method: "PUT",
        body: input,
        auth: true,
      });
    },
    deleteComment: (commentId: number) =>
      request(`/v1/comments/${commentId}`, okResponseSchema, {
        method: "DELETE",
        auth: true,
      }),
    getVote: (itemId: number) =>
      request(`/v1/items/${itemId}/vote`, voteResponseSchema, { auth: true }),
    setVote: (itemId: number, input: VotePut) => {
      votePutSchema.parse(input);
      return request(`/v1/items/${itemId}/vote`, voteResponseSchema, {
        method: "PUT",
        body: input,
        auth: true,
      });
    },
    clearVote: (itemId: number) =>
      request(`/v1/items/${itemId}/vote`, voteResponseSchema, {
        method: "DELETE",
        auth: true,
      }),
    listSubscriptions: () =>
      request("/v1/subscriptions", subscriptionListResponseSchema, { auth: true }),
    getNewEpisodes: () =>
      request("/v1/subscriptions/new-episodes", newEpisodesResponseSchema, { auth: true }),
    subscribe: (itemId: number, input: SubscriptionPut = { notify: true }) => {
      subscriptionPutSchema.parse(input);
      return request(`/v1/subscriptions/${itemId}`, subscriptionResponseSchema, {
        method: "PUT",
        body: input,
        auth: true,
      });
    },
    unsubscribe: (itemId: number) =>
      request(`/v1/subscriptions/${itemId}`, subscriptionResponseSchema, {
        method: "DELETE",
        auth: true,
      }),

    /* meta */
    listTypes: () => request("/v1/types", typesResponseSchema),
    listGenres: (type?: string) =>
      request("/v1/genres", genresResponseSchema, { query: { type } }),
    listCountries: () => request("/v1/countries", countriesResponseSchema),
  };

  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export type { AuthResponse, ItemDetail, ItemPage, MediaLinks, MediaTracks, Tokens, User };
