/**
 * Контракты социального слоя: подписки на новые серии, дерево комментариев,
 * голосование like/dislike и сводное состояние тайтла.
 */
import { z } from "zod";
import { itemTypeSchema } from "./common";

/* ---------- Подписки ---------- */

/** Лёгкая проекция тайтла для списков подписок. */
export const subscriptionItemSchema = z.object({
  id: z.number().int(),
  type: itemTypeSchema,
  title: z.string(),
  year: z.number().int().nullable(),
  posterMedium: z.string().nullable(),
});
export type SubscriptionItem = z.infer<typeof subscriptionItemSchema>;

export const subscriptionSchema = z.object({
  itemId: z.number().int(),
  notify: z.boolean(),
  createdAt: z.string(),
  item: subscriptionItemSchema,
});
export type SubscriptionDto = z.infer<typeof subscriptionSchema>;

export const subscriptionPutSchema = z.object({
  notify: z.boolean().default(true),
});
export type SubscriptionPut = z.infer<typeof subscriptionPutSchema>;

export const subscriptionResponseSchema = z.object({
  subscription: subscriptionSchema.nullable(),
});
export const subscriptionListResponseSchema = z.object({
  items: z.array(subscriptionSchema),
});

/**
 * Новинка из подписок: kind="episode" — новая серия сериала,
 * kind="part" — новая часть фильма (partNumber > 1).
 */
export const newEpisodeSchema = z.object({
  kind: z.enum(["episode", "part"]),
  itemId: z.number().int(),
  itemTitle: z.string(),
  mediaId: z.number().int(),
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  episodeTitle: z.string().nullable(),
  partNumber: z.number().int().nullable(),
  /** Собственное имя media (для частей фильмов). */
  title: z.string().nullable(),
  runtime: z.number().int(),
  publishedAt: z.string(),
});
export type NewEpisodeDto = z.infer<typeof newEpisodeSchema>;

export const newEpisodesResponseSchema = z.object({
  items: z.array(newEpisodeSchema),
  /** Сколько всего недосмотренных новинок (для badge в шапке). */
  total: z.number().int(),
});

/* ---------- Комментарии ---------- */

export const commentAuthorSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;

/**
 * Комментарий отдаётся плоским списком с parentId/depth — дерево
 * собирает клиент (так удобнее и пагинация, и оптимистичный UI).
 */
export const commentSchema = z.object({
  id: z.number().int(),
  itemId: z.number().int(),
  parentId: z.number().int().nullable(),
  depth: z.number().int(),
  body: z.string(),
  deleted: z.boolean(),
  author: commentAuthorSchema,
  createdAt: z.string(),
  /** Пустой, пока комментарий не редактировали. */
  updatedAt: z.string(),
});
export type CommentDto = z.infer<typeof commentSchema>;

export const commentPostSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  parentId: z.number().int().positive().nullable().optional(),
});
export type CommentPost = z.infer<typeof commentPostSchema>;

export const commentPutSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type CommentPut = z.infer<typeof commentPutSchema>;

export const commentResponseSchema = z.object({ comment: commentSchema });

/**
 * Постранично по корневым веткам: страница — это корни целиком со всеми
 * ответами, nextOffset — смещение следующей страницы веток (null — конец).
 */
export const commentListResponseSchema = z.object({
  items: z.array(commentSchema),
  nextOffset: z.number().int().nullable(),
  /** Всего корневых веток у тайтла. */
  total: z.number().int(),
});

export const commentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CommentListQuery = z.infer<typeof commentListQuerySchema>;

/* ---------- Голосование ---------- */

export const voteStateSchema = z.object({
  itemId: z.number().int(),
  /** Мой голос: true — за, false — против, null — не голосовал. */
  myVote: z.boolean().nullable(),
  votes: z.object({
    positive: z.number().int(),
    negative: z.number().int(),
    total: z.number().int(),
  }),
});
export type VoteStateDto = z.infer<typeof voteStateSchema>;

export const votePutSchema = z.object({ positive: z.boolean() });
export type VotePut = z.infer<typeof votePutSchema>;

export const voteResponseSchema = z.object({ vote: voteStateSchema });

/* ---------- Сводное состояние тайтла ---------- */

export const itemSocialSchema = z.object({
  vote: voteStateSchema,
  subscription: subscriptionSchema.nullable(),
  commentsCount: z.number().int(),
});
export type ItemSocialDto = z.infer<typeof itemSocialSchema>;

export const itemSocialResponseSchema = z.object({ social: itemSocialSchema });
