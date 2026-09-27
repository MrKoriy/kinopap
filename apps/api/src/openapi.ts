/**
 * OpenAPI 3.1 спецификация. Компоненты генерируются из zod-схем
 * (@zal/api-client) через z.toJSONSchema — контракт не разъезжается.
 */
import { z } from "zod";
import {
  apiErrorSchema,
  authResponseSchema,
  countrySchema,
  genreSchema,
  ingestJobStatusSchema,
  ingestRequestSchema,
  progressPutSchema,
  progressSchema,
  itemDetailSchema,
  itemPageSchema,
  itemSummarySchema,
  mediaLinksSchema,
  commentListResponseSchema,
  commentPostSchema,
  commentPutSchema,
  commentResponseSchema,
  commentSchema,
  itemSocialResponseSchema,
  newEpisodeSchema,
  newEpisodesResponseSchema,
  refreshResponseSchema,
  subscriptionListResponseSchema,
  subscriptionPutSchema,
  subscriptionResponseSchema,
  subscriptionSchema,
  votePutSchema,
  voteResponseSchema,
  voteStateSchema,
  tokensSchema,
  userSchema,
} from "@zal/api-client";

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
        RegisterInput: {
          type: "object",
          required: ["invite", "email", "password", "name"],
          properties: {
            invite: { type: "string" },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
            name: { type: "string" },
          },
        },
        LoginInput: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        },
        RefreshInput: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string" } },
        },
        Health: { type: "object", properties: { ok: { type: "boolean" } } },
        ItemSummary: z.toJSONSchema(itemSummarySchema),
        ItemDetail: z.toJSONSchema(itemDetailSchema),
        ItemPage: z.toJSONSchema(itemPageSchema),
        MediaLinks: z.toJSONSchema(mediaLinksSchema),
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
