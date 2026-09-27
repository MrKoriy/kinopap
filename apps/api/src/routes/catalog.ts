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
  items,
  listCountries,
  listGenres,
  listItems,
  media,
  mediaLinks,
  searchItems,
  shortcutItems,
  similarItems,
  type Db,
} from "@zal/db";
import { StreamResolver } from "@zal/ingest";
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
    let result = await searchItems(db, {
      q: q.q,
      type: q.type,
      field: q.field,
      limit: q.limit,
    });

    // If local catalog doesn't have it, discover on-the-fly from Rutor + TMDb
    if (result.items.length === 0 && q.q.trim().length >= 2) {
      try {
        const queryTerm = q.q.trim();
        const releases = await streamResolver.rutor.search(queryTerm);
        if (releases.length > 0) {
          const topRel = releases[0];
          const m = topRel.title.match(/^([^/\[(]+)(?:\/\s*([^/\[(]+))?\s*(?:\[[^\]]+\])?\s*(?:\((\d{4})\))?/);
          let title = m ? m[1].trim() : queryTerm;
          let originalTitle = m && m[2] ? m[2].trim() : null;
          let year = m && m[3] ? parseInt(m[3], 10) : topRel.year ?? null;
          let plot = `Релиз: ${topRel.title}`;
          let rating = 8.0;
          let posterSmall: string | null = null;
          let posterMedium: string | null = null;
          let posterBig: string | null = null;

          // Enrich with official TMDb poster, plot and rating
          try {
            const tmdbUrl = new URL("https://api.themoviedb.org/3/search/multi");
            tmdbUrl.searchParams.set("api_key", "844dba0bfd8f3a4f3799f6130ef9e335");
            tmdbUrl.searchParams.set("language", "ru-RU");
            tmdbUrl.searchParams.set("query", title);
            const tmdbRes = await fetch(tmdbUrl, { signal: AbortSignal.timeout(3500) });
            if (tmdbRes.ok) {
              const tmdbData = (await tmdbRes.json()) as { results?: Array<Record<string, unknown>> };
              const hit = tmdbData.results?.[0];
              if (hit) {
                if (hit.title || hit.name) title = String(hit.title || hit.name);
                if (hit.original_title || hit.original_name) {
                  originalTitle = String(hit.original_title || hit.original_name);
                }
                const dateStr = String(hit.release_date || hit.first_air_date || "");
                if (dateStr.length >= 4) {
                  const parsedYear = parseInt(dateStr.slice(0, 4), 10);
                  if (!isNaN(parsedYear)) year = parsedYear;
                }
                if (hit.overview) plot = String(hit.overview);
                if (typeof hit.vote_average === "number" && hit.vote_average > 0) {
                  rating = Math.round(hit.vote_average * 10) / 10;
                }
                if (hit.poster_path) {
                  const p = String(hit.poster_path);
                  posterSmall = `https://image.tmdb.org/t/p/w185${p}`;
                  posterMedium = `https://image.tmdb.org/t/p/w500${p}`;
                  posterBig = `https://image.tmdb.org/t/p/original${p}`;
                }
              }
            }
          } catch {
            // Keep parsed fallback
          }

          const isSerial = /s\d+|сезон|серии/i.test(topRel.title);

          const [inserted] = await db
            .insert(items)
            .values({
              type: isSerial ? "serial" : "movie",
              title,
              originalTitle,
              year,
              plot,
              rating,
              quality: topRel.quality.includes("2160") ? 2160 : 1080,
              posterSmall,
              posterMedium,
              posterBig,
            })
            .returning({ id: items.id });

          if (inserted) {
            await db.insert(media).values({
              itemId: inserted.id,
              title,
              runtime: 7200,
            });

            result = await searchItems(db, {
              q: title,
              type: q.type,
              field: q.field,
              limit: q.limit,
            });
          }
        }
      } catch {
        // Fallback to empty result
      }
    }

    return result;
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

  const streamResolver = new StreamResolver({
    torrServerBaseUrl: config.torrServerUrl,
    torrServerPublicUrl: config.torrServerPublicUrl,
  });

  /** Ссылки на видео/аудио/субтитры для media (их /items/media-links). */
  app.get("/items/:id/media-links", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const { mid } = parseOrThrow(mediaLinksQuerySchema, request.query ?? {});
    let links = await mediaLinks(db, id, mid, config.mediaBaseUrl);
    if (!links) {
      const [insertedMedia] = await db
        .insert(media)
        .values({ itemId: id, partNumber: 1, title: "Основной" })
        .returning({ id: media.id });
      links = {
        mediaId: insertedMedia?.id ?? mid,
        itemId: id,
        files: [],
        audios: [],
        subtitles: [],
        posterUrl: null,
        sprites: null,
        intro: null,
      };
    }

    // Zero-storage dynamic resolution: if no pre-encoded files in DB, resolve from stream sources
    if (links.files.length === 0) {
      const item = await getItem(db, id);
      if (item) {
        const resolved = await streamResolver.resolve({
          itemId: id,
          mediaId: mid,
          title: item.title,
          originalTitle: item.originalTitle,
          year: item.year,
          type: item.type,
        });
        if (resolved.files.length > 0) {
          links.files = resolved.files;
          if (resolved.audios.length > 0) {
            links.audios = resolved.audios;
          }
          if (resolved.intro && !links.intro) {
            links.intro = resolved.intro;
          }
        }
      }
    }

    return links;
  });

  app.get("/items/:id/similar", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return similarItems(db, id);
  });
}
