/**
 * Личный кабинет: сохранённое, подборки, история просмотра, сводка и
 * прогресс по тайтлу (для галочек на сериях).
 *
 * Всё персональное — за auth и скоупится дефолтным профилем пользователя.
 * Публичность подборок (is_public) пока только флаг: чужие подборки по
 * прямой ссылке отдадим, когда появится страница подборки.
 */

import { userListCreateSchema, userListUpdateSchema } from "@zal/api-client";
import {
  addFavorite,
  addItemToList,
  clearHistory,
  createUserList,
  type Db,
  deleteHistoryEntry,
  deleteUserList,
  findUserById,
  getDefaultProfile,
  getFavorite,
  getUserList,
  listFavorites,
  listHistory,
  listItemProgress,
  listUserLists,
  profileStats,
  removeFavorite,
  removeItemFromList,
  updateUserList,
} from "@zal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { notFound, parseOrThrow } from "../lib/http";
import { toUserDto } from "./auth";

const itemParamsSchema = z.object({ itemId: z.coerce.number().int().positive() });
const listParamsSchema = z.object({ listId: z.coerce.number().int().positive() });
const listItemParamsSchema = z.object({
  listId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const mediaParamsSchema = z.object({ mediaId: z.coerce.number().int().positive() });
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function profileRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config },
): Promise<void> {
  const { db } = deps;

  /** Всё для страницы кабинета одним запросом: счётчики + три списка. */
  app.get("/profile/overview", { preHandler: app.authenticate }, async (request) => {
    const profile = await getDefaultProfile(db, request.user.sub);
    const [user, stats, history, favorites, lists] = await Promise.all([
      findUserById(db, request.user.sub),
      profileStats(db, profile.id),
      listHistory(db, profile.id, { limit: 20 }),
      listFavorites(db, profile.id, 20),
      listUserLists(db, profile.id),
    ]);
    if (!user) throw notFound("User not found");

    return {
      profile: {
        user: toUserDto(user),
        stats,
        history: history.items,
        favorites,
        lists,
      },
    };
  });

  /* ---------- Сохранённое ---------- */

  app.get("/favorites", { preHandler: app.authenticate }, async (request) => {
    const profile = await getDefaultProfile(db, request.user.sub);
    return { items: await listFavorites(db, profile.id) };
  });

  app.get("/favorites/:itemId", { preHandler: app.authenticate }, async (request) => {
    const { itemId } = parseOrThrow(itemParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    return { favorite: await getFavorite(db, profile.id, itemId) };
  });

  app.put("/favorites/:itemId", { preHandler: app.authenticate }, async (request) => {
    const { itemId } = parseOrThrow(itemParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    const favorite = await addFavorite(db, profile.id, itemId);
    if (!favorite) throw notFound(`Item ${itemId} not found`);
    return { favorite };
  });

  app.delete("/favorites/:itemId", { preHandler: app.authenticate }, async (request) => {
    const { itemId } = parseOrThrow(itemParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    await removeFavorite(db, profile.id, itemId);
    return { favorite: null };
  });

  /* ---------- Подборки ---------- */

  app.get("/lists", { preHandler: app.authenticate }, async (request) => {
    const profile = await getDefaultProfile(db, request.user.sub);
    return { items: await listUserLists(db, profile.id) };
  });

  app.post("/lists", { preHandler: app.authenticate }, async (request, reply) => {
    const body = parseOrThrow(userListCreateSchema, request.body ?? {});
    const profile = await getDefaultProfile(db, request.user.sub);
    const list = await createUserList(db, profile.id, body);
    reply.code(201);
    return { list };
  });

  app.get("/lists/:listId", { preHandler: app.authenticate }, async (request) => {
    const { listId } = parseOrThrow(listParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    const list = await getUserList(db, profile.id, listId);
    if (!list) throw notFound(`List ${listId} not found`);
    return { list };
  });

  app.patch("/lists/:listId", { preHandler: app.authenticate }, async (request) => {
    const { listId } = parseOrThrow(listParamsSchema, request.params);
    const patch = parseOrThrow(userListUpdateSchema, request.body ?? {});
    const profile = await getDefaultProfile(db, request.user.sub);
    const list = await updateUserList(db, profile.id, listId, patch);
    if (!list) throw notFound(`List ${listId} not found`);
    return { list };
  });

  app.delete("/lists/:listId", { preHandler: app.authenticate }, async (request) => {
    const { listId } = parseOrThrow(listParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    const removed = await deleteUserList(db, profile.id, listId);
    if (!removed) throw notFound(`List ${listId} not found`);
    return { ok: true };
  });

  app.put(
    "/lists/:listId/items/:itemId",
    { preHandler: app.authenticate },
    async (request) => {
      const { listId, itemId } = parseOrThrow(listItemParamsSchema, request.params);
      const profile = await getDefaultProfile(db, request.user.sub);
      const ok = await addItemToList(db, profile.id, listId, itemId);
      if (!ok) throw notFound(`List ${listId} not found`);
      const list = await getUserList(db, profile.id, listId);
      return { list };
    },
  );

  app.delete(
    "/lists/:listId/items/:itemId",
    { preHandler: app.authenticate },
    async (request) => {
      const { listId, itemId } = parseOrThrow(listItemParamsSchema, request.params);
      const profile = await getDefaultProfile(db, request.user.sub);
      await removeItemFromList(db, profile.id, listId, itemId);
      const list = await getUserList(db, profile.id, listId);
      if (!list) throw notFound(`List ${listId} not found`);
      return { list };
    },
  );

  /* ---------- История ---------- */

  app.get("/history", { preHandler: app.authenticate }, async (request) => {
    const q = parseOrThrow(historyQuerySchema, request.query ?? {});
    const profile = await getDefaultProfile(db, request.user.sub);
    return listHistory(db, profile.id, q);
  });

  app.delete("/history", { preHandler: app.authenticate }, async (request) => {
    const profile = await getDefaultProfile(db, request.user.sub);
    const removed = await clearHistory(db, profile.id);
    return { ok: true, removed };
  });

  app.delete("/history/:mediaId", { preHandler: app.authenticate }, async (request) => {
    const { mediaId } = parseOrThrow(mediaParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    await deleteHistoryEntry(db, profile.id, mediaId);
    return { ok: true };
  });

  /* ---------- Прогресс по тайтлу (сезоны/серии) ---------- */

  /**
   * Все записи прогресса тайтла одним запросом: карточка сериала рисует
   * галочки по сериям и выбирает активный сезон, не дёргая прогресс
   * отдельно на каждую серию.
   */
  app.get("/items/:id/progress", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    return { progress: await listItemProgress(db, profile.id, id) };
  });
}
