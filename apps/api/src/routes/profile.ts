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
  getFavorite,
  getFavoritesBatch,
  getUserList,
  listFavorites,
  listHistory,
  listItemProgress,
  listsContainingItem,
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
import { idParamsSchema } from "../lib/params";
import { requireProfileId } from "../plugins/auth";
import { toUserDto } from "./auth";

const itemParamsSchema = z.object({ itemId: z.coerce.number().int().positive() });
const listParamsSchema = z.object({ listId: z.coerce.number().int().positive() });
const listItemParamsSchema = z.object({
  listId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});
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
    const profileId = await requireProfileId(db, request);
    const [user, stats, history, favorites, lists] = await Promise.all([
      findUserById(db, request.user.sub),
      profileStats(db, profileId),
      listHistory(db, profileId, { limit: 20 }),
      listFavorites(db, profileId, 20),
      listUserLists(db, profileId),
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
    const profileId = await requireProfileId(db, request);
    return { items: await listFavorites(db, profileId) };
  });

  /** Батч-проверка закладок — один SELECT вместо N getFavorite на рельсе. */
  app.get("/favorites/batch", { preHandler: app.authenticate }, async (request) => {
    const q = parseOrThrow(
      z.object({ ids: z.string().min(1) }),
      request.query ?? {},
    );
    const ids = q.ids
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 100);
    const profileId = await requireProfileId(db, request);
    const set = await getFavoritesBatch(db, profileId, ids);
    return { favorites: [...set] };
  });

  app.get("/favorites/:itemId", { preHandler: app.authenticate }, async (request) => {
    const { itemId } = parseOrThrow(itemParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    return { favorite: await getFavorite(db, profileId, itemId) };
  });

  app.put("/favorites/:itemId", { preHandler: app.authenticate }, async (request) => {
    const { itemId } = parseOrThrow(itemParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    const favorite = await addFavorite(db, profileId, itemId);
    if (!favorite) throw notFound(`Item ${itemId} not found`);
    return { favorite };
  });

  app.delete("/favorites/:itemId", { preHandler: app.authenticate }, async (request) => {
    const { itemId } = parseOrThrow(itemParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    await removeFavorite(db, profileId, itemId);
    return { favorite: null };
  });

  /* ---------- Подборки ---------- */

  /** Принадлежность тайтла подборкам — один SELECT вместо N getList. */
  app.get("/lists/membership", { preHandler: app.authenticate }, async (request) => {
    const q = parseOrThrow(
      z.object({ itemId: z.coerce.number().int().positive() }),
      request.query ?? {},
    );
    const profileId = await requireProfileId(db, request);
    const set = await listsContainingItem(db, profileId, q.itemId);
    return { lists: [...set] };
  });

  app.get("/lists", { preHandler: app.authenticate }, async (request) => {
    const profileId = await requireProfileId(db, request);
    return { items: await listUserLists(db, profileId) };
  });

  app.post("/lists", { preHandler: app.authenticate }, async (request, reply) => {
    const body = parseOrThrow(userListCreateSchema, request.body ?? {});
    const profileId = await requireProfileId(db, request);
    const list = await createUserList(db, profileId, body);
    reply.code(201);
    return { list };
  });

  app.get("/lists/:listId", { preHandler: app.authenticate }, async (request) => {
    const { listId } = parseOrThrow(listParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    const list = await getUserList(db, profileId, listId);
    if (!list) throw notFound(`List ${listId} not found`);
    return { list };
  });

  app.patch("/lists/:listId", { preHandler: app.authenticate }, async (request) => {
    const { listId } = parseOrThrow(listParamsSchema, request.params);
    const patch = parseOrThrow(userListUpdateSchema, request.body ?? {});
    const profileId = await requireProfileId(db, request);
    const list = await updateUserList(db, profileId, listId, patch);
    if (!list) throw notFound(`List ${listId} not found`);
    return { list };
  });

  app.delete("/lists/:listId", { preHandler: app.authenticate }, async (request) => {
    const { listId } = parseOrThrow(listParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    const removed = await deleteUserList(db, profileId, listId);
    if (!removed) throw notFound(`List ${listId} not found`);
    return { ok: true };
  });

  app.put(
    "/lists/:listId/items/:itemId",
    { preHandler: app.authenticate },
    async (request) => {
      const { listId, itemId } = parseOrThrow(listItemParamsSchema, request.params);
      const profileId = await requireProfileId(db, request);
      const ok = await addItemToList(db, profileId, listId, itemId);
      if (!ok) throw notFound(`List ${listId} not found`);
      const list = await getUserList(db, profileId, listId);
      return { list };
    },
  );

  app.delete(
    "/lists/:listId/items/:itemId",
    { preHandler: app.authenticate },
    async (request) => {
      const { listId, itemId } = parseOrThrow(listItemParamsSchema, request.params);
      const profileId = await requireProfileId(db, request);
      await removeItemFromList(db, profileId, listId, itemId);
      const list = await getUserList(db, profileId, listId);
      if (!list) throw notFound(`List ${listId} not found`);
      return { list };
    },
  );

  /* ---------- История ---------- */

  app.get("/history", { preHandler: app.authenticate }, async (request) => {
    const q = parseOrThrow(historyQuerySchema, request.query ?? {});
    const profileId = await requireProfileId(db, request);
    return listHistory(db, profileId, q);
  });

  app.delete("/history", { preHandler: app.authenticate }, async (request) => {
    const profileId = await requireProfileId(db, request);
    const removed = await clearHistory(db, profileId);
    return { ok: true, removed };
  });

  app.delete("/history/:mediaId", { preHandler: app.authenticate }, async (request) => {
    const { mediaId } = parseOrThrow(mediaParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    await deleteHistoryEntry(db, profileId, mediaId);
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
    const profileId = await requireProfileId(db, request);
    return { progress: await listItemProgress(db, profileId, id) };
  });
}
