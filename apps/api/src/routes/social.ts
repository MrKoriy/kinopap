/**
 * Социальный слой: подписки на новые серии, дерево комментариев,
 * голосование. Всё персональное — за auth, чтение — публичное.
 */

import {
  type CommentDto,
  commentListQuerySchema,
  commentPostSchema,
  commentPutSchema,
  subscriptionPutSchema,
  votePutSchema,
} from "@zal/api-client";
import {
  addComment,
  countComments,
  type Db,
  deleteSubscription,
  getComment,
  getCommentAuthorUserId,
  getDefaultProfile,
  getSubscription,
  getVoteState,
  listCommentsPage,
  listNewEpisodes,
  listSubscriptions,
  ParentCommentNotFoundError,
  removeVote,
  setVote,
  softDeleteComment,
  updateComment,
  upsertSubscription,
} from "@zal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { badRequest, forbidden, notFound, parseOrThrow } from "../lib/http";
import { idParamsSchema } from "../lib/params";
import { optionalUser, requireProfileId } from "../plugins/auth";

const subParamsSchema = z.object({ itemId: z.coerce.number().int().positive() });

export async function socialRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config },
): Promise<void> {
  const { db } = deps;

  async function assertItem(itemId: number): Promise<void> {
    const state = await getVoteState(db, null, itemId);
    if (!state) throw notFound(`Item ${itemId} not found`);
  }

  /* ---------- Сводное состояние тайтла ---------- */

  /** Голос + подписка + число комментариев одним запросом для карточки. */
  app.get("/items/:id/social", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const user = await optionalUser(request);
    // pid из токена; старый токен без pid — дорезолв из БД.
    const profileId = user
      ? (user.pid ?? (await getDefaultProfile(db, user.sub)).id)
      : null;

    const vote = await getVoteState(db, profileId, id);
    if (!vote) throw notFound(`Item ${id} not found`);
    const subscription = profileId != null
      ? await getSubscription(db, profileId, id)
      : null;
    const commentsCount = await countComments(db, id);

    return { social: { vote, subscription, commentsCount } };
  });

  /* ---------- Комментарии ---------- */

  /** Постранично по корневым веткам: страница — корни со всеми ответами. */
  app.get("/items/:id/comments", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const q = parseOrThrow(commentListQuerySchema, request.query ?? {});
    await assertItem(id);
    return listCommentsPage(db, id, q.limit, q.offset);
  });

  app.post(
    "/items/:id/comments",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const body = parseOrThrow(commentPostSchema, request.body);
    await assertItem(id);

    const profileId = await requireProfileId(db, request);
    let comment: CommentDto;
    try {
      comment = await addComment(db, {
        itemId: id,
        profileId: profileId,
        parentId: body.parentId ?? null,
        body: body.body,
      });
    } catch (err) {
      if (err instanceof ParentCommentNotFoundError) {
        throw badRequest("parent_not_found", "Родительский комментарий не найден");
      }
      throw err;
    }
    reply.code(201);
    return { comment };
  });

  /** Редактировать может только автор (admin/owner — через удаление). */
  app.put("/comments/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const body = parseOrThrow(commentPutSchema, request.body);
    const existing = await getComment(db, id);
    if (!existing || existing.deleted) throw notFound(`Comment ${id} not found`);

    const authorUserId = await getCommentAuthorUserId(db, id);
    if (authorUserId !== request.user.sub) {
      throw forbidden("Можно редактировать только свои комментарии");
    }

    const comment = await updateComment(db, id, body.body);
    if (!comment) throw notFound(`Comment ${id} not found`);
    return { comment };
  });

  /** Удалить может автор или admin/owner; комментарий остаётся в дереве. */
  app.delete("/comments/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const existing = await getComment(db, id);
    if (!existing || existing.deleted) throw notFound(`Comment ${id} not found`);

    const authorUserId = await getCommentAuthorUserId(db, id);
    const isStaff = request.user.role === "admin" || request.user.role === "owner";
    if (authorUserId !== request.user.sub && !isStaff) {
      throw forbidden("Можно удалять только свои комментарии");
    }

    await softDeleteComment(db, id);
    return { ok: true };
  });

  /* ---------- Голосование ---------- */

  app.get("/items/:id/vote", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    const vote = await getVoteState(db, profileId, id);
    if (!vote) throw notFound(`Item ${id} not found`);
    return { vote };
  });

  app.put(
    "/items/:id/vote",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const body = parseOrThrow(votePutSchema, request.body);
    await assertItem(id);
    const profileId = await requireProfileId(db, request);
    return { vote: await setVote(db, profileId, id, body.positive) };
  });

  app.delete("/items/:id/vote", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    await assertItem(id);
    const profileId = await requireProfileId(db, request);
    return { vote: await removeVote(db, profileId, id) };
  });

  /* ---------- Подписки ---------- */

  app.get("/subscriptions", { preHandler: app.authenticate }, async (request) => {
    const profileId = await requireProfileId(db, request);
    return { items: await listSubscriptions(db, profileId) };
  });

  /** Лента «новое по подпискам»: серии и части, что ещё не досмотрены. */
  app.get("/subscriptions/new-episodes", { preHandler: app.authenticate }, async (request) => {
    const profileId = await requireProfileId(db, request);
    return listNewEpisodes(db, profileId);
  });

  app.put(
    "/subscriptions/:itemId",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
    const { itemId } = parseOrThrow(subParamsSchema, request.params);
    const body = parseOrThrow(subscriptionPutSchema, request.body ?? {});
    await assertItem(itemId);
    const profileId = await requireProfileId(db, request);
    return { subscription: await upsertSubscription(db, profileId, itemId, body.notify) };
  });

  app.delete("/subscriptions/:itemId", { preHandler: app.authenticate }, async (request) => {
    const { itemId } = parseOrThrow(subParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    await deleteSubscription(db, profileId, itemId);
    return { subscription: null };
  });
}
