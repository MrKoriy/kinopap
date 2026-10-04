/**
 * GET /v1/items/:id/online — источники онлайн-балансеров для тайтла.
 *
 * Ответ кэшируется в Redis: найденное на 12 ч, пустое на 2 ч (балансеры
 * добавляют новинки в течение дня). IMDb-ID, которого нет в каталоге,
 * дотягиваем из TMDb external_ids и сохраняем — по нему матч точный.
 */
import { type Db, items, resolveItemRedirect } from "@zal/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Config } from "../config";
import { balancersEnabled, findOnlineSources, type OnlineSource, parseImdbTag } from "../lib/balancers";
import { HttpError, parseOrThrow } from "../lib/http";
import { tmdbGet } from "../lib/tmdb";

const idParams = z.object({ id: z.coerce.number().int().positive() });
const HIT_TTL_S = 12 * 3600;
const MISS_TTL_S = 2 * 3600;
const cacheKey = (id: number) => `online:v1:${id}`;

export async function onlineRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    config: Config;
    redis: Redis | null;
    find?: typeof findOnlineSources;
  },
) {
  const { db, config, redis } = opts;
  const find = opts.find ?? findOnlineSources;

  async function cached(id: number): Promise<OnlineSource[] | null> {
    if (!redis) return null;
    try {
      const raw = await Promise.race([
        redis.get(cacheKey(id)),
        new Promise<null>((r) => setTimeout(() => r(null), 300)),
      ]);
      return raw ? (JSON.parse(raw) as OnlineSource[]) : null;
    } catch {
      return null;
    }
  }

  app.get("/items/:id/online", async (request, reply) => {
    const { id: rawId } = parseOrThrow(idParams, request.params);
    if (!balancersEnabled(config)) return { enabled: false, sources: [] };

    const id = (await resolveItemRedirect(db, rawId)) ?? rawId;
    const hit = await cached(id);
    if (hit) {
      reply.header("cache-control", "public, max-age=600");
      return { enabled: true, sources: hit };
    }

    const [row] = await db
      .select({
        type: items.type,
        tmdbId: items.tmdbId,
        tmdbType: items.tmdbType,
        imdbId: items.imdbId,
        kinopoiskId: items.kinopoiskId,
        title: items.title,
        originalTitle: items.originalTitle,
        year: items.year,
      })
      .from(items)
      .where(eq(items.id, id))
      .limit(1);
    if (!row) throw new HttpError(404, "not_found", `Item ${id} not found`);

    let imdbId = row.imdbId;
    if (!imdbId && row.tmdbId && row.tmdbType) {
      const ext = await tmdbGet<{ imdb_id?: string | null }>(config, `/${row.tmdbType}/${row.tmdbId}/external_ids`);
      imdbId = parseImdbTag(ext?.imdb_id);
      if (imdbId) await db.update(items).set({ imdbId }).where(eq(items.id, id));
    }

    const sources = await find(config, {
      type: row.type,
      tmdbId: row.tmdbId,
      tmdbType: row.tmdbType,
      imdbId,
      kinopoiskId: row.kinopoiskId,
      title: row.title,
      originalTitle: row.originalTitle,
      year: row.year,
    });
    if (redis) {
      redis.set(cacheKey(id), JSON.stringify(sources), "EX", sources.length ? HIT_TTL_S : MISS_TTL_S).catch(() => {});
    }
    reply.header("cache-control", "public, max-age=600");
    return { enabled: true, sources };
  });
}
