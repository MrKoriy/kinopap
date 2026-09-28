import {
  type IntroMarker,
  ITEM_TYPE_TITLES,
  ITEM_TYPES,
  type ItemPage,
  type MediaFile,
  type MediaTracks,
  parseCatalogQuery,
  searchRawQuerySchema,
  shortcutQuerySchema,
  type WarmRelease,
} from "@zal/api-client";
import {
  type Db,
  episodes,
  getItem,
  getSource,
  isSourceFresh,
  items,
  listCountries,
  listGenres,
  listItems,
  media,
  mediaLinks,
  patchSource,
  saveSource,
  searchItems,
  seasons,
  shortcutItems,
  similarItems,
} from "@zal/db";
import { StreamResolver } from "@zal/ingest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { notFound, parseOrThrow } from "../lib/http";
import type { AccessPayload } from "../plugins/auth";

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const mediaLinksQuerySchema = z.object({ mid: z.coerce.number().int().positive() });

/** TTL кэша on-the-fly резолва стримов: повторное открытие watch-страницы
 * не должно снова ходить в rutor (до ~12с латентности). */
const RESOLVE_CACHE_TTL_MS = 30 * 60 * 1000;
/** TTL кэша в БД: переживает рестарт API, но не копится бесконечно. */
const RESOLVE_DB_TTL_MS = 6 * 60 * 60 * 1000;

/** Одна запись кэша резолва (L1 — память процесса). */
interface ResolveCacheEntry {
  at: number;
  files: MediaFile[];
  audios: MediaTracks["audios"];
  intro: IntroMarker | null;
  /** Прогретый релиз; null — прогрев ещё едет или провалился. */
  warm: WarmRelease | null;
}

/** Опциональная авторизация: гость — это гость, а не 401. */
async function optionalUser(request: FastifyRequest): Promise<AccessPayload | null> {
  try {
    await request.jwtVerify();
    return request.user.typ === "access" ? request.user : null;
  } catch {
    return null;
  }
}

interface TmdbHit {
  title: string;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  rating: number;
  posterSmall: string | null;
  posterMedium: string | null;
  posterBig: string | null;
}

/** Поиск метаданных в официальном TMDb API (ключ — только из env). */
async function tmdbLookup(
  config: Config,
  title: string,
  year: number | null,
): Promise<TmdbHit | null> {
  if (!config.tmdbApiKey) return null;
  const tmdbUrl = new URL("https://api.themoviedb.org/3/search/multi");
  tmdbUrl.searchParams.set("api_key", config.tmdbApiKey);
  tmdbUrl.searchParams.set("language", "ru-RU");
  tmdbUrl.searchParams.set("include_adult", "false");
  tmdbUrl.searchParams.set("query", title);
  try {
    const tmdbRes = await fetch(tmdbUrl, { signal: AbortSignal.timeout(3500) });
    if (!tmdbRes.ok) return null;
    const data = (await tmdbRes.json()) as { results?: Array<Record<string, unknown>> };
    // Предпочитаем совпадение по году, иначе первый результат.
    const results = data.results ?? [];
    const withYear = year
      ? results.find((r) => {
          const d = String(r.release_date ?? r.first_air_date ?? "");
          return d.length >= 4 && parseInt(d.slice(0, 4), 10) === year;
        })
      : undefined;
    const hit = withYear ?? results[0];
    if (!hit) return null;
    const out: TmdbHit = {
      title: String(hit.title ?? hit.name ?? title),
      originalTitle: hit.original_title ?? hit.original_name
        ? String(hit.original_title ?? hit.original_name)
        : null,
      year,
      plot: hit.overview ? String(hit.overview) : null,
      rating: 0,
      posterSmall: null,
      posterMedium: null,
      posterBig: null,
    };
    const dateStr = String(hit.release_date ?? hit.first_air_date ?? "");
    if (dateStr.length >= 4) {
      const parsedYear = parseInt(dateStr.slice(0, 4), 10);
      if (!Number.isNaN(parsedYear)) out.year = parsedYear;
    }
    if (typeof hit.vote_average === "number" && hit.vote_average > 0) {
      out.rating = Math.round(hit.vote_average * 10) / 10;
    }
    if (hit.poster_path) {
      const p = String(hit.poster_path);
      out.posterSmall = `https://image.tmdb.org/t/p/w185${p}`;
      out.posterMedium = `https://image.tmdb.org/t/p/w500${p}`;
      out.posterBig = `https://image.tmdb.org/t/p/original${p}`;
    }
    return out;
  } catch {
    return null;
  }
}

export async function catalogRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config },
): Promise<void> {
  const { db, config } = deps;

  // Кэш zero-storage резолва: item/media → ссылки. L1 — память процесса,
  // L2 — таблица media_sources в БД (переживает рестарт/деплой).
  const resolveCache = new Map<string, ResolveCacheEntry>();
  /** Одновременные пробы дорожек на одну пару не должны дублироваться. */
  const trackProbes = new Map<string, Promise<MediaTracks>>();

  /** Сезон и серия media — их ждёт резолвер (поиск «s01e05», эпизоды аниме). */
  async function episodeContext(
    targetDb: Db,
    mediaId: number,
  ): Promise<{ seasonNumber: number | null; episodeNumber: number | null }> {
    const rows = await targetDb
      .select({ season: seasons.number, episode: episodes.number })
      .from(media)
      .leftJoin(episodes, eq(episodes.id, media.episodeId))
      .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(eq(media.id, mediaId))
      .limit(1);
    return {
      seasonNumber: rows[0]?.season ?? null,
      episodeNumber: rows[0]?.episode ?? null,
    };
  }

  function applyCached(links: {
    files: MediaFile[];
    audios: MediaTracks["audios"];
    intro: IntroMarker | null;
  }, entry: ResolveCacheEntry): void {
    links.files = entry.files;
    links.audios = entry.audios;
    links.intro = entry.intro;
  }

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

  app.get(
    "/items/search",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
    const q = parseOrThrow(searchRawQuerySchema, request.query ?? {});
    let result = await searchItems(db, {
      q: q.q,
      type: q.type,
      field: q.field,
      limit: q.limit,
    });

    // On-the-fly discovery: ходит в rutor и TMDb и пишет в БД — только для
    // авторизованных. Аноним ищет по локальному каталогу.
    if (result.items.length === 0 && q.q.trim().length >= 2) {
      const user = await optionalUser(request);
      if (user) {
        try {
          const queryTerm = q.q.trim();
          const releases = await streamResolver.rutor.search(queryTerm);
          if (releases.length > 0) {
            const topRel = releases[0]!;
            const m = topRel.title.match(/^([^/[(]+)(?:\/\s*([^/[(]+))?\s*(?:\[[^\]]+\])?\s*(?:\((\d{4})\))?/);
            let title = m ? m[1]!.trim() : queryTerm;
            let originalTitle = m?.[2] ? m[2]!.trim() : null;
            let year = m?.[3] ? parseInt(m[3]!, 10) : topRel.year ?? null;
            let plot = `Релиз: ${topRel.title}`;
            let rating = 0;
            let posterSmall: string | null = null;
            let posterMedium: string | null = null;
            let posterBig: string | null = null;

            const tmdb = await tmdbLookup(config, title, year);
            if (tmdb) {
              title = tmdb.title;
              originalTitle = tmdb.originalTitle ?? originalTitle;
              year = tmdb.year ?? year;
              if (tmdb.plot) plot = tmdb.plot;
              if (tmdb.rating > 0) rating = tmdb.rating;
              posterSmall = tmdb.posterSmall;
              posterMedium = tmdb.posterMedium;
              posterBig = tmdb.posterBig;
            }

            // Дедуп: тот же тайтл с тем же годом уже в каталоге — не плодим дубли.
            const dupConds = [sql`${items.title} ilike ${title}`];
            if (year != null) dupConds.push(eq(items.year, year));
            const dup = await db
              .select({ id: items.id })
              .from(items)
              .where(and(...dupConds))
              .limit(1);

            if (dup.length === 0) {
              const isSerial = /s\d+|сезон|серии/i.test(topRel.title);

              await db.insert(items).values({
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
              });
              result = await searchItems(db, {
                q: queryTerm,
                type: q.type,
                field: q.field,
                limit: q.limit,
              });
            }
          }
        } catch {
          // Discovery не должен ломать поиск: локальный результат уже есть.
        }
      }
    }

    return result;
  });

  // Кэш лент shortcuts: hero/rails главной дергают fresh/hot/popular на
  // каждый ISR-рендер. 60с в памяти снимает шаблонный SQL-шторм.
  const shortcutCache = new Map<string, { at: number; page: ItemPage }>();
  const SHORTCUT_CACHE_TTL_MS = 60_000;

  for (const kind of ["fresh", "hot", "popular"] as const) {
    app.get(`/items/${kind}`, async (request) => {
      const q = parseOrThrow(shortcutQuerySchema, request.query ?? {});
      const cacheKey = `${kind}:${q.type ?? ""}:${q.limit}:${q.cursor ?? ""}`;
      const cached = shortcutCache.get(cacheKey);
      if (cached && Date.now() - cached.at < SHORTCUT_CACHE_TTL_MS) {
        return cached.page;
      }
      const page = await shortcutItems(db, kind, {
        type: q.type,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
      shortcutCache.set(cacheKey, { at: Date.now(), page });
      if (shortcutCache.size > 200) {
        // Простейшая гигиена: режем протухшие записи.
        const now = Date.now();
        for (const [k, v] of shortcutCache) {
          if (now - v.at >= SHORTCUT_CACHE_TTL_MS) shortcutCache.delete(k);
        }
      }
      return page;
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
    anilibriaBaseUrl: config.anilibriaUrl,
  });

  /** Ссылки на видео/аудио/субтитры для media (их /items/media-links). */
  app.get("/items/:id/media-links", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const { mid } = parseOrThrow(mediaLinksQuerySchema, request.query ?? {});
    let links = await mediaLinks(db, id, mid, config.mediaBaseUrl);
    if (!links) {
      // Чужая пара (item, media) — 404. Заглушку создаём только если у item
      // вообще нет ни одной media-строки (лонч с карточки без media).
      const anyMedia = await db
        .select({ id: media.id })
        .from(media)
        .where(eq(media.itemId, id))
        .limit(1);
      if (anyMedia.length > 0) throw notFound(`Media ${mid} not found for item ${id}`);
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
      const cacheKey = `${id}:${links.mediaId}`;
      const cached = resolveCache.get(cacheKey);
      if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL_MS) {
        applyCached(links, cached);
        return links;
      }

      // L2 — БД: прогрев и список релизов переживают рестарт API. Раньше
      // кэш жил только в памяти, и каждый деплой обнулял прогретые торренты.
      const stored = await getSource(db, id, links.mediaId).catch(() => null);
      if (stored && isSourceFresh(stored, RESOLVE_DB_TTL_MS)) {
        const entry: ResolveCacheEntry = {
          at: Date.now(),
          files: stored.files,
          audios: stored.audios,
          intro: stored.intro,
          warm: stored.warm,
        };
        resolveCache.set(cacheKey, entry);
        applyCached(links, entry);
        return links;
      }

      const item = await getItem(db, id);
      if (item) {
        // external id — точный матч релиза AniLibria для аниме-тайтлов.
        const [ext] = await db
          .select({ source: items.externalSource, id: items.externalId })
          .from(items)
          .where(eq(items.id, id))
          .limit(1);
        const { seasonNumber, episodeNumber } = await episodeContext(db, links.mediaId);
        const startedAt = Date.now();
        const resolved = await streamResolver.resolve({
          itemId: id,
          mediaId: links.mediaId,
          title: item.title,
          originalTitle: item.originalTitle,
          year: item.year,
          type: item.type,
          seasonNumber: seasonNumber ?? undefined,
          episodeNumber: episodeNumber ?? undefined,
          externalSource: ext?.source ?? null,
          externalId: ext?.id ?? null,
          warm: stored?.warm ?? null,
        });
        if (resolved.files.length > 0) {
          links.files = resolved.files;
          if (resolved.audios.length > 0) {
            links.audios = resolved.audios;
          }
          if (resolved.intro && !links.intro) {
            links.intro = resolved.intro;
          }
          const entry: ResolveCacheEntry = {
            at: Date.now(),
            files: resolved.files,
            audios: resolved.audios,
            intro: resolved.intro,
            warm: resolved.warm,
          };
          resolveCache.set(cacheKey, entry);
          console.log(
            `resolve: item=${id} media=${links.mediaId} in ${Date.now() - startedAt}ms ` +
              `files=${resolved.files.length} warm=${resolved.warm ? "ready" : "pending"}`,
          );
          void saveSource(db, {
            itemId: id,
            mediaId: links.mediaId,
            files: resolved.files,
            audios: resolved.audios,
            intro: resolved.intro,
            warm: resolved.warm,
          }).catch(() => {
            // Кэш в БД опционален — падение записи не должно ломать просмотр.
          });
          // Прогрев не уложился в бюджет — допишем, когда доехает.
          if (!resolved.warm) {
            void streamResolver
              .warmFor(id, links.mediaId)
              .then((warm) =>
                warm ? patchSource(db, id, links.mediaId, { warm }) : undefined,
              )
              .catch(() => {});
          }
        }
      }
    }

    return links;
  });

  /**
   * Ленивые аудио-дорожки прогретого релиза (gst-проба). Плеер дёргает их
   * уже во время воспроизведения: проба на холодных пирах занимает до 45с
   * и не должна задерживать старт видео. Нет прогрева — просто пусто,
   * плеер остаётся на базовой дорожке.
   */
  app.get(
    "/items/:id/media-tracks",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = parseOrThrow(idParamsSchema, request.params);
      const { mid } = parseOrThrow(mediaLinksQuerySchema, request.query ?? {});
      const key = `${id}:${mid}`;
      const inflight = trackProbes.get(key);
      if (inflight) return inflight;

      const task = (async (): Promise<MediaTracks> => {
        const empty: MediaTracks = { itemId: id, mediaId: mid, audios: [] };
        const cacheKey = `${id}:${mid}`;
        const l1 = resolveCache.get(cacheKey);
        if (l1?.audios.length) return { ...empty, audios: l1.audios };

        const stored = await getSource(db, id, mid).catch(() => null);
        if (stored?.audios.length) {
          resolveCache.set(cacheKey, {
            at: Date.now(),
            files: stored.files,
            audios: stored.audios,
            intro: stored.intro,
            warm: stored.warm,
          });
          return { ...empty, audios: stored.audios };
        }

        const warm =
          l1?.warm ??
          stored?.warm ??
          (await streamResolver.warmFor(id, mid).catch(() => null));
        if (!warm) return empty;

        const audios = await streamResolver.tracksFor(warm);
        if (audios.length) {
          if (l1) l1.audios = audios;
          else {
            resolveCache.set(cacheKey, {
              at: Date.now(),
              files: stored?.files ?? [],
              audios,
              intro: stored?.intro ?? null,
              warm,
            });
          }
          void patchSource(db, id, mid, { audios, warm }).catch(() => {});
        }
        return { ...empty, audios };
      })();

      trackProbes.set(key, task);
      try {
        return await task;
      } finally {
        trackProbes.delete(key);
      }
    },
  );

  app.get("/items/:id/similar", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return similarItems(db, id);
  });
}
