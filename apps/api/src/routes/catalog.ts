import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ITEM_TYPES,
  ITEM_TYPE_TITLES,
  searchRawQuerySchema,
  shortcutQuerySchema,
  parseCatalogQuery,
} from "@zal/api-client";
import {
  getItem,
  listCountries,
  listGenres,
  listItems,
  mediaLinks,
  searchItems,
  shortcutItems,
  similarItems,
  type Db,
} from "@zal/db";
import type { Config } from "../config";
import { notFound, parseOrThrow } from "../lib/http";

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const mediaLinksQuerySchema = z.object({ mid: z.coerce.number().int().positive() });

export async function catalogRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config },
): Promise<void> {
  const { db, config } = deps;

  /** Типы контента: movie/serial/concert/docu/tvshow/3d/4k. */
  app.get("/types", async () => ({
    types: ITEM_TYPES.map((id) => ({ id, title: ITEM_TYPE_TITLES[id] })),
  }));

  app.get("/genres", async (request) => {
    const q = z.object({ type: z.string().optional() }).parse(request.query ?? {});
    return { genres: await listGenres(db, q.type) };
  });

  app.get("/countries", async () => ({
    countries: await listCountries(db),
  }));

  /** Список с фильтрами и cursor-пагинацией (формат фильтров как в API 1.3). */
  app.get("/items", async (request) => {
    const filters = parseCatalogQuery(request.query ?? {});
    return listItems(db, filters);
  });

  app.get("/items/search", async (request) => {
    const q = parseOrThrow(searchRawQuerySchema, request.query ?? {});
    return searchItems(db, {
      q: q.q,
      type: q.type,
      field: q.field,
      limit: q.limit,
    });
  });

  for (const kind of ["fresh", "hot", "popular"] as const) {
    app.get(`/items/${kind}`, async (request) => {
      const q = parseOrThrow(shortcutQuerySchema, request.query ?? {});
      return shortcutItems(db, kind, {
        type: q.type,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
    });
  }

  app.get("/items/:id", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const item = await getItem(db, id);
    if (!item) throw notFound(`Item ${id} not found`);
    return item;
  });

  /** Ссылки на видео/аудио/субтитры для media (их /items/media-links). */
  app.get("/items/:id/media-links", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const { mid } = parseOrThrow(mediaLinksQuerySchema, request.query ?? {});
    const links = await mediaLinks(db, id, mid, config.mediaBaseUrl);
    if (!links) throw notFound("Media not found for this item");
    return links;
  });

  app.get("/items/:id/similar", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return similarItems(db, id);
  });
}
