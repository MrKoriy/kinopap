/**
 * OpenAPI 3.1 спецификация. Компоненты генерируются из zod-схем
 * (@zal/api-client) через z.toJSONSchema — контракт не разъезжается.
 */

import {
  apiErrorSchema,
  authResponseSchema,
  commentListResponseSchema,
  commentPostSchema,
  commentPutSchema,
  commentResponseSchema,
  commentSchema,
  countrySchema,
  favoriteListResponseSchema,
  favoriteResponseSchema,
  favoriteSchema,
  genreSchema,
  historyEntrySchema,
  historyListResponseSchema,
  ingestJobStatusSchema,
  ingestRequestSchema,
  itemDetailSchema,
  itemPageSchema,
  itemProgressEntrySchema,
  itemProgressResponseSchema,
  itemProgressSchema,
  itemSocialResponseSchema,
  itemSummarySchema,
  loginSchema,
  mediaLinksSchema,
  mediaTracksSchema,
  newEpisodeSchema,
  newEpisodesResponseSchema,
  profileItemSchema,
  profileOverviewResponseSchema,
  profileStatsSchema,
  progressPutSchema,
  progressSchema,
  refreshResponseSchema,
  refreshSchema,
  registerSchema,
  subscriptionListResponseSchema,
  subscriptionPutSchema,
  subscriptionResponseSchema,
  subscriptionSchema,
  tokensSchema,
  userListCreateSchema,
  userListDetailResponseSchema,
  userListListResponseSchema,
  userListSchema,
  userListUpdateSchema,
  userSchema,
  votePutSchema,
  voteResponseSchema,
  voteStateSchema,
} from "@zal/api-client";
import { z } from "zod";
import { discoverBodySchema } from "./routes/discovery";

const errorResponse = {
  description: "Ошибка",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
  },
};

function jsonBody(schemaRef: string, description = "OK") {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: `#/components/schemas/${schemaRef}` } },
    },
  };
}

export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Зал API",
      version: "1.0.0",
      description:
        "REST API стриминг-платформы «Зал». Философия API 1.3 kino.pub, " +
        "но с cursor-пагинацией и единым форматом ошибок.",
    },
    paths: {
      "/healthz": {
        get: { summary: "Health check", responses: { 200: jsonBody("Health") } },
      },
      "/v1/auth/register": {
        post: {
          summary: "Регистрация по инвайт-коду",
          requestBody: jsonBody("RegisterInput"),
          responses: {
            201: jsonBody("AuthResponse"),
            400: errorResponse,
            409: errorResponse,
          },
        },
      },
      "/v1/auth/login": {
        post: {
          summary: "Вход (email + пароль)",
          requestBody: jsonBody("LoginInput"),
          responses: { 200: jsonBody("AuthResponse"), 401: errorResponse },
        },
      },
      "/v1/auth/refresh": {
        post: {
          summary: "Ротация refresh-токена",
          requestBody: jsonBody("RefreshInput"),
          responses: { 200: jsonBody("RefreshResponse"), 401: errorResponse },
        },
      },
      "/v1/auth/logout": {
        post: {
          summary: "Выход (отзыв refresh-токена)",
          responses: { 200: jsonBody("LogoutResponse") },
        },
      },
      "/v1/auth/me": {
        get: {
          summary: "Текущий пользователь",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("MeResponse"), 401: errorResponse },
        },
      },
      "/v1/invites": {
        get: {
          summary: "Список инвайтов (owner/admin)",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("InvitesResponse"), 401: errorResponse, 403: errorResponse },
        },
        post: {
          summary: "Создать инвайт (owner/admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody("InviteCreateInput"),
          responses: { 201: jsonBody("InviteResponse"), 400: errorResponse, 401: errorResponse, 403: errorResponse },
        },
      },
      "/v1/discover": {
        post: {
          summary: "Наполнение каталога из TMDb/AniLibria (owner/admin)",
          description:
            "Со включённым Redis — постановка фоновой джобы (queued: true, jobId), " +
            "без Redis — синхронный прогон с summary в ответе.",
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody("DiscoverInput"),
          responses: { 200: jsonBody("DiscoverResponse"), 400: errorResponse, 401: errorResponse, 403: errorResponse },
        },
      },
      "/v1/discover/status": {
        get: {
          summary: "Прогресс фоновой заливки каталога (owner/admin)",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "job", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: { 200: jsonBody("DiscoverStatusResponse"), 401: errorResponse, 403: errorResponse, 404: errorResponse },
        },
      },
      "/v1/types": {
        get: { summary: "Типы контента", responses: { 200: jsonBody("TypesResponse") } },
      },
      "/v1/genres": {
        get: {
          summary: "Жанры",
          parameters: [
            {
              name: "type",
              in: "query",
              schema: { type: "string" },
              description: "movie | music | docu | tvshow",
            },
          ],
          responses: { 200: jsonBody("GenresResponse") },
        },
      },
      "/v1/countries": {
        get: { summary: "Страны", responses: { 200: jsonBody("CountriesResponse") } },
      },
      "/v1/items": {
        get: {
          summary: "Каталог: фильтры + cursor-пагинация",
          parameters: [
            { name: "type", in: "query", schema: { type: "string" } },
            { name: "title", in: "query", schema: { type: "string" } },
            { name: "genre", in: "query", schema: { type: "string" }, description: "id через запятую" },
            { name: "country", in: "query", schema: { type: "string" }, description: "id через запятую" },
            { name: "year", in: "query", schema: { type: "string" }, description: "1990-2000 или 2001" },
            { name: "letter", in: "query", schema: { type: "string" } },
            { name: "actor", in: "query", schema: { type: "string" } },
            { name: "director", in: "query", schema: { type: "string" } },
            { name: "sort", in: "query", schema: { type: "string" }, description: "updated- | year | rating- | ..." },
            { name: "limit", in: "query", schema: { type: "integer", default: 25 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: jsonBody("ItemPage") },
        },
      },
      "/v1/items/search": {
        get: {
          summary: "Поиск по title/director/cast",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "field", in: "query", schema: { type: "string", enum: ["title", "director", "cast"] } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          ],
          responses: { 200: jsonBody("ItemPage") },
        },
      },
      "/v1/items/fresh": { get: { summary: "Свежие", responses: { 200: jsonBody("ItemPage") } } },
      "/v1/items/hot": { get: { summary: "Горячие (просмотры)", responses: { 200: jsonBody("ItemPage") } } },
      "/v1/items/popular": { get: { summary: "Популярные (рейтинг)", responses: { 200: jsonBody("ItemPage") } } },
      "/v1/items/{id}": {
        get: {
          summary: "Карточка: сезоны/эпизоды или media-части",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("ItemDetail"), 404: errorResponse },
        },
      },
      "/v1/items/{id}/media-links": {
        get: {
          summary: "Видео/аудио/субтитры для media",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "mid", in: "query", required: true, schema: { type: "integer" } },
          ],
          responses: { 200: jsonBody("MediaLinks"), 404: errorResponse },
        },
      },
      "/v1/items/{id}/media-tracks": {
        get: {
          summary: "Ленивые аудио-дорожки прогретого релиза (gst-проба в фоне)",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "mid", in: "query", required: true, schema: { type: "integer" } },
          ],
          responses: { 200: jsonBody("MediaTracks") },
        },
      },
      "/v1/items/{id}/similar": {
        get: {
          summary: "Похожие (общие жанры)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("ItemPage"), 404: errorResponse },
        },
      },
      "/v1/items/{id}/social": {
        get: {
          summary: "Социальное состояние тайтла: голос, подписка, комментарии",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("ItemSocialResponse"), 404: errorResponse },
        },
      },
      "/v1/items/{id}/comments": {
        get: {
          summary: "Комментарии тайтла: страница веток целиком, дерево на клиенте",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 }, description: "веток на страницу" },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: jsonBody("CommentListResponse"), 404: errorResponse },
        },
        post: {
          summary: "Новый комментарий или ответ",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: jsonBody("CommentPost"),
          responses: {
            201: jsonBody("CommentResponse"),
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
          },
        },
      },
      "/v1/comments/{id}": {
        put: {
          summary: "Редактирование комментария (только автор)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: jsonBody("CommentPut"),
          responses: {
            200: jsonBody("CommentResponse"),
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
          },
        },
        delete: {
          summary: "Мягкое удаление комментария (автор или admin/owner)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: jsonBody("OkResponse"),
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
          },
        },
      },
      "/v1/items/{id}/vote": {
        get: {
          summary: "Мой голос и суммы",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("VoteResponse"), 401: errorResponse, 404: errorResponse },
        },
        put: {
          summary: "Голос за/против (идемпотентно, смена голоса — перевес)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: jsonBody("VotePut"),
          responses: { 200: jsonBody("VoteResponse"), 401: errorResponse, 404: errorResponse },
        },
        delete: {
          summary: "Снять голос",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("VoteResponse"), 401: errorResponse, 404: errorResponse },
        },
      },
      "/v1/subscriptions": {
        get: {
          summary: "Мои подписки на тайтлы",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("SubscriptionListResponse"), 401: errorResponse },
        },
      },
      "/v1/subscriptions/new-episodes": {
        get: {
          summary: "Лента новых серий по подпискам (недосмотренные)",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("NewEpisodesResponse"), 401: errorResponse },
        },
      },
      "/v1/subscriptions/{itemId}": {
        put: {
          summary: "Подписаться на тайтл (идемпотентно)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: jsonBody("SubscriptionPut"),
          responses: { 200: jsonBody("SubscriptionResponse"), 401: errorResponse, 404: errorResponse },
        },
        delete: {
          summary: "Отписаться",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("SubscriptionResponse"), 401: errorResponse },
        },
      },
      "/v1/ingest": {
        post: {
          summary: "Запуск ingest источника (owner/admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody("IngestRequest"),
          responses: {
            202: jsonBody("IngestResponse", "Задача поставлена в очередь"),
            403: errorResponse,
            503: errorResponse,
          },
        },
      },
      "/v1/ingest/{id}": {
        get: {
          summary: "Статус ingest-задачи",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("IngestResponse"), 404: errorResponse },
        },
      },
      "/v1/progress": {
        get: {
          summary: "Лента «продолжить просмотр»",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("ProgressListResponse"), 401: errorResponse },
        },
      },
      "/v1/progress/{mediaId}": {
        get: {
          summary: "Прогресс по media (резюме)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "mediaId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("ProgressResponse"), 401: errorResponse },
        },
        put: {
          summary: "Сохранить позицию просмотра",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "mediaId", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: jsonBody("ProgressPut"),
          responses: { 200: jsonBody("ProgressResponse"), 404: errorResponse },
        },
      },
      "/v1/profile/overview": {
        get: {
          summary: "Кабинет: счётчики, история, сохранённое, подборки",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("ProfileOverviewResponse"), 401: errorResponse },
        },
      },
      "/v1/favorites": {
        get: {
          summary: "Сохранённое («Смотреть позже»)",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("FavoriteListResponse"), 401: errorResponse },
        },
      },
      "/v1/favorites/{itemId}": {
        get: {
          summary: "Закладка по тайтлу",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("FavoriteResponse"), 401: errorResponse },
        },
        put: {
          summary: "Сохранить тайтл (идемпотентно)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: jsonBody("FavoriteResponse"),
            401: errorResponse,
            404: errorResponse,
          },
        },
        delete: {
          summary: "Убрать из сохранённого",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("FavoriteResponse"), 401: errorResponse },
        },
      },
      "/v1/lists": {
        get: {
          summary: "Мои подборки",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("UserListListResponse"), 401: errorResponse },
        },
        post: {
          summary: "Создать подборку",
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody("UserListCreate"),
          responses: { 201: jsonBody("UserListResponse"), 401: errorResponse },
        },
      },
      "/v1/lists/{listId}": {
        get: {
          summary: "Подборка с тайтлами",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "listId", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: jsonBody("UserListDetailResponse"),
            401: errorResponse,
            404: errorResponse,
          },
        },
        patch: {
          summary: "Переименовать/описать/открыть подборку",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "listId", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: jsonBody("UserListUpdate"),
          responses: {
            200: jsonBody("UserListResponse"),
            401: errorResponse,
            404: errorResponse,
          },
        },
        delete: {
          summary: "Удалить подборку",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "listId", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: jsonBody("OkResponse"),
            401: errorResponse,
            404: errorResponse,
          },
        },
      },
      "/v1/lists/{listId}/items/{itemId}": {
        put: {
          summary: "Добавить тайтл в подборку (идемпотентно)",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "listId", in: "path", required: true, schema: { type: "integer" } },
            { name: "itemId", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: {
            200: jsonBody("UserListDetailResponse"),
            401: errorResponse,
            404: errorResponse,
          },
        },
        delete: {
          summary: "Убрать тайтл из подборки",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "listId", in: "path", required: true, schema: { type: "integer" } },
            { name: "itemId", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: {
            200: jsonBody("UserListDetailResponse"),
            401: errorResponse,
            404: errorResponse,
          },
        },
      },
      "/v1/history": {
        get: {
          summary: "История просмотра (включая завершённое)",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: jsonBody("HistoryListResponse"), 401: errorResponse },
        },
        delete: {
          summary: "Очистить историю просмотра",
          security: [{ bearerAuth: [] }],
          responses: { 200: jsonBody("OkResponse"), 401: errorResponse },
        },
      },
      "/v1/history/{mediaId}": {
        delete: {
          summary: "Удалить одну запись истории",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "mediaId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("OkResponse"), 401: errorResponse },
        },
      },
      "/v1/items/{id}/progress": {
        get: {
          summary: "Прогресс всех media тайтла (галочки по сериям)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: jsonBody("ItemProgressResponse"), 401: errorResponse },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        ApiError: z.toJSONSchema(apiErrorSchema),
        User: z.toJSONSchema(userSchema),
        Tokens: z.toJSONSchema(tokensSchema),
        AuthResponse: z.toJSONSchema(authResponseSchema),
        RefreshResponse: z.toJSONSchema(refreshResponseSchema),
        LogoutResponse: { type: "object", properties: { ok: { type: "boolean" } } },
        MeResponse: {
          type: "object",
          properties: { user: { $ref: "#/components/schemas/User" } },
        },
        RegisterInput: z.toJSONSchema(registerSchema),
        LoginInput: z.toJSONSchema(loginSchema),
        RefreshInput: z.toJSONSchema(refreshSchema),
        InviteCreateInput: {
          type: "object",
          properties: {
            maxUses: { type: "integer", minimum: 1, maximum: 100, default: 1 },
            expiresInDays: { type: "integer", minimum: 1, maximum: 365 },
          },
        },
        Invite: {
          type: "object",
          required: ["code", "maxUses", "uses", "expiresAt"],
          properties: {
            code: { type: "string" },
            maxUses: { type: "integer" },
            uses: { type: "integer" },
            expiresAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        InviteResponse: {
          type: "object",
          properties: { invite: { $ref: "#/components/schemas/Invite" } },
        },
        InvitesResponse: {
          type: "object",
          properties: {
            invites: { type: "array", items: { $ref: "#/components/schemas/Invite" } },
          },
        },
        DiscoverInput: z.toJSONSchema(discoverBodySchema),
        DiscoverResponse: {
          type: "object",
          description:
            "queued=true — задача в фоне (jobId для /v1/discover/status); " +
            "queued=false — синхронный прогон с итогом summary.",
          properties: {
            queued: { type: "boolean" },
            jobId: { type: "string" },
            summary: { type: "object", description: "FillSummary" },
          },
        },
        DiscoverStatusResponse: {
          type: "object",
          properties: {
            jobId: { type: "string" },
            state: {
              type: "string",
              enum: ["queued", "active", "completed", "failed", "unknown"],
            },
            progress: { type: ["object", "null"], description: "FillProgress" },
            result: { type: ["object", "null"], description: "FillSummary" },
            error: { type: ["string", "null"] },
          },
        },
        Health: { type: "object", properties: { ok: { type: "boolean" } } },
        ItemSummary: z.toJSONSchema(itemSummarySchema),
        ItemDetail: z.toJSONSchema(itemDetailSchema),
        ItemPage: z.toJSONSchema(itemPageSchema),
        MediaLinks: z.toJSONSchema(mediaLinksSchema),
        MediaTracks: z.toJSONSchema(mediaTracksSchema),
        Genre: z.toJSONSchema(genreSchema),
        Country: z.toJSONSchema(countrySchema),
        GenresResponse: {
          type: "object",
          properties: {
            genres: { type: "array", items: { $ref: "#/components/schemas/Genre" } },
          },
        },
        CountriesResponse: {
          type: "object",
          properties: {
            countries: { type: "array", items: { $ref: "#/components/schemas/Country" } },
          },
        },
        Progress: z.toJSONSchema(progressSchema),
        ProgressPut: z.toJSONSchema(progressPutSchema),
        ProgressResponse: {
          type: "object",
          properties: {
            progress: {
              oneOf: [
                { $ref: "#/components/schemas/Progress" },
                { type: "null" },
              ],
            },
          },
        },
        ProgressListResponse: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/Progress" },
            },
          },
        },
        OkResponse: { type: "object", properties: { ok: { type: "boolean" } } },
        ProfileItem: z.toJSONSchema(profileItemSchema),
        ProfileStats: z.toJSONSchema(profileStatsSchema),
        ProfileOverviewResponse: z.toJSONSchema(profileOverviewResponseSchema),
        Favorite: z.toJSONSchema(favoriteSchema),
        FavoriteListResponse: z.toJSONSchema(favoriteListResponseSchema),
        FavoriteResponse: z.toJSONSchema(favoriteResponseSchema),
        UserList: z.toJSONSchema(userListSchema),
        UserListCreate: z.toJSONSchema(userListCreateSchema),
        UserListUpdate: z.toJSONSchema(userListUpdateSchema),
        UserListResponse: {
          type: "object",
          properties: { list: { $ref: "#/components/schemas/UserList" } },
        },
        UserListDetailResponse: z.toJSONSchema(userListDetailResponseSchema),
        UserListListResponse: z.toJSONSchema(userListListResponseSchema),
        HistoryEntry: z.toJSONSchema(historyEntrySchema),
        HistoryListResponse: z.toJSONSchema(historyListResponseSchema),
        ItemProgressEntry: z.toJSONSchema(itemProgressEntrySchema),
        ItemProgressResponse: z.toJSONSchema(itemProgressResponseSchema),
        ItemProgress: z.toJSONSchema(itemProgressSchema),
        Comment: z.toJSONSchema(commentSchema),
        CommentPost: z.toJSONSchema(commentPostSchema),
        CommentPut: z.toJSONSchema(commentPutSchema),
        CommentResponse: z.toJSONSchema(commentResponseSchema),
        CommentListResponse: z.toJSONSchema(commentListResponseSchema),
        VoteState: z.toJSONSchema(voteStateSchema),
        VotePut: z.toJSONSchema(votePutSchema),
        VoteResponse: z.toJSONSchema(voteResponseSchema),
        Subscription: z.toJSONSchema(subscriptionSchema),
        SubscriptionPut: z.toJSONSchema(subscriptionPutSchema),
        SubscriptionResponse: z.toJSONSchema(subscriptionResponseSchema),
        SubscriptionListResponse: z.toJSONSchema(subscriptionListResponseSchema),
        NewEpisode: z.toJSONSchema(newEpisodeSchema),
        NewEpisodesResponse: z.toJSONSchema(newEpisodesResponseSchema),
        ItemSocialResponse: z.toJSONSchema(itemSocialResponseSchema),
        IngestRequest: z.toJSONSchema(ingestRequestSchema),
        IngestJobStatus: z.toJSONSchema(ingestJobStatusSchema),
        IngestResponse: {
          type: "object",
          properties: {
            job: { $ref: "#/components/schemas/IngestJobStatus" },
          },
        },
        TypesResponse: {
          type: "object",
          properties: {
            types: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, title: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };
}
