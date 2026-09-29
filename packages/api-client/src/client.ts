/**
 * Типизированный HTTP-клиент API «Зал».
 * Общий для web и mobile: пара fetch + базовый URL, ошибки — в ApiError.
 */

import {
  type AuthResponse,
  authResponseSchema,
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
  type MediaLinks,
  type MediaTracks,
  mediaLinksSchema,
  mediaTracksSchema,
  typesResponseSchema,
} from "./catalog";
import type { ApiErrorBody, ItemType } from "./common";
import { apiErrorSchema } from "./common";
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

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Веб: "include" — httpOnly-cookie с refresh-токеном ходит с запросами. */
  credentials?: "include" | "same-origin" | "omit";
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
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.auth && accessToken) headers.authorization = `Bearer ${accessToken}`;

    const res = await doFetch(buildUrl(opts.baseUrl, path, init.query), {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      keepalive: init.keepalive ?? false,
      credentials: opts.credentials,
    });

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

    health: () =>
      request("/healthz", { parse: (v) => v as { ok: boolean } }),

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

    /* catalog */
    listItems: (filters: CatalogFilters) =>
      request("/v1/items", itemPageSchema, {
        query: filtersToQuery(filters) as Record<string, unknown>,
      }),
    searchItems: (q: {
      q: string;
      type?: ItemType;
      field?: "title" | "director" | "cast";
      limit?: number;
    }) => request("/v1/items/search", itemPageSchema, { query: q }),
    getItem: (id: number) => request(`/v1/items/${id}`, itemDetailSchema),
    getMediaLinks: (itemId: number, mediaId: number) =>
      request(`/v1/items/${itemId}/media-links`, mediaLinksSchema, {
        query: { mid: mediaId },
      }),
    /**
     * Ленивые аудио-дорожки прогретого релиза: подтягиваются фоном, пока
     * плеер уже играет — gst-проба на холодных пирах занимает до 45с и не
     * должна блокировать старт воспроизведения.
     */
    getMediaTracks: (itemId: number, mediaId: number) =>
      request(`/v1/items/${itemId}/media-tracks`, mediaTracksSchema, {
        query: { mid: mediaId },
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
      request(`/v1/lists/${listId}`, { parse: (v) => v as { ok: boolean } }, {
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
      request("/v1/history", { parse: (v) => v as { ok: boolean; removed: number } }, {
        method: "DELETE",
        auth: true,
      }),
    deleteHistoryEntry: (mediaId: number) =>
      request(`/v1/history/${mediaId}`, { parse: (v) => v as { ok: boolean } }, {
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
      request(`/v1/comments/${commentId}`, { parse: (v) => v as { ok: boolean } }, {
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
