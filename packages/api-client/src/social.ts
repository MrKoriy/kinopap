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

/** Новая серия из подписок — лента «что вышло». */
export const newEpisodeSchema = z.object({
  itemId: z.number().int(),
  itemTitle: z.string(),
  mediaId: z.number().int(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  episodeTitle: z.string().nullable(),
  runtime: z.number().int(),
  publishedAt: z.string(),
});
export type NewEpisodeDto = z.infer<typeof newEpisodeSchema>;

export const newEpisodesResponseSchema = z.object({
  items: z.array(newEpisodeSchema),
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
});
export type CommentDto = z.infer<typeof commentSchema>;

export const commentPostSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  parentId: z.number().int().positive().nullable().optional(),
});
export type CommentPost = z.infer<typeof commentPostSchema>;

export const commentResponseSchema = z.object({ comment: commentSchema });
export const commentListResponseSchema = z.object({
  items: z.array(commentSchema),
});

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
