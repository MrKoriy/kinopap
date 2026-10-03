/**
 * Слой TMDb: поиск метаданных по названию и ленивая гидрация сезонов.
 *
 * Вынесено из `routes/catalog.ts`. Роуты оттуда пользуются ровно двумя
 * вещами — `tmdbLookup` и `hydrateSerialSeasons`, — а всё остальное (запросы
 * к TMDb, разбор ответов, пачки сезонов, дедупликация одинаковых запросов в
 * полёте) к HTTP не имеет отношения. В одном файле это давало 763 строки, где
 * транспортный слой и клиент чужого API перемешаны.
 */
import { applyEnrichment, type Db, episodes, media, seasons } from "@zal/db";
import { pickTrailer } from "@zal/ingest";
import { and, eq } from "drizzle-orm";
import type { Config } from "../config";

export interface TmdbHit {
  title: string;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  rating: number;
  posterSmall: string | null;
  posterMedium: string | null;
  posterBig: string | null;
  /** YouTube-ключ трейлера и ссылка — заполняются, когда TMDb их отдал. */
  trailerId: string | null;
  trailerUrl: string | null;
}

interface TmdbVideoRow {
  key?: string;
  site?: string;
  type?: string;
  official?: boolean;
}

/**
 * Трейлер тайтла: официальный YouTube-трейлер, при отсутствии — тизер.
 * Сначала русская дорожка: локализованных трейлеров меньше, но если он есть —
 * он полезнее для зрителя.
 */
async function tmdbTrailer(
  config: Config,
  kind: "movie" | "tv",
  tmdbId: number,
): Promise<{ id: string; url: string } | null> {
  for (const language of ["ru-RU", "en-US"]) {
    const data = await tmdbGet<{ results?: TmdbVideoRow[] }>(
      config,
      `/${kind}/${tmdbId}/videos`,
      language,
    );
    const key = pickTrailer(data?.results ?? []);
    if (key) return { id: key, url: `https://www.youtube.com/watch?v=${key}` };
  }
  return null;
}

/** Поиск метаданных в официальном TMDb API (ключ — только из env). */
export async function tmdbLookup(
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
      trailerId: null,
      trailerUrl: null,
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
    // Трейлер — отдельным запросом: search/multi его не отдаёт. Ошибку
    // глотаем, трейлер не повод не показать карточку.
    const tmdbId = Number(hit.id);
    if (Number.isFinite(tmdbId) && tmdbId > 0) {
      const kind: "movie" | "tv" =
        hit.media_type === "tv" || hit.first_air_date ? "tv" : "movie";
      const trailer = await tmdbTrailer(config, kind, tmdbId).catch(() => null);
      if (trailer) {
        out.trailerId = trailer.id;
        out.trailerUrl = trailer.url;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Ленивая гидрация сезонов для сериалов из заливки: fill создаёт item без
 * эпизодов (TMDb discover не отдаёт их состав), и карточка выходила без
 * выбора серий — только «Смотреть». При первом открытии карточки сезоны и
 * эпизоды подтягиваются с TMDb и навсегда остаются в БД.
 *
 * Сбои источника кэшируются на 10 минут, чтобы битый сериал не долбил TMDb
 * на каждом открытии; одинаковые запросы делятся в полёте.
 */
const HYDRATE_RETRY_MS = 10 * 60 * 1000;
const hydrateMissedAt = new Map<number, number>();
const hydratePending = new Map<string, Promise<boolean>>();

/** Потолок негативного кэша: без него карта растёт вечно на каталоге
 * из тысяч «немых» тайтлов. Переполнение — просто сброс: записи
 * однородные по времени, потеря части не страшна. */
const HYDRATE_MISSED_MAX = 2000;

interface TmdbEpisode {
  number: number;
  title: string | null;
  /** Секунды — в таком виде runtime хранится у эпизодов аниме. */
  runtime: number;
  thumbnailUrl: string | null;
}

export async function tmdbGet<T>(
  config: Config,
  path: string,
  language = "ru-RU",
): Promise<T | null> {
  if (!config.tmdbApiKey) return null;
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", config.tmdbApiKey);
  url.searchParams.set("language", language);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function tmdbShowSeasons(
  config: Config,
  tmdbId: number,
): Promise<Array<{ number: number; title: string | null }>> {
  const data = await tmdbGet<{ seasons?: Array<Record<string, unknown>> }>(
    config,
    `/tv/${tmdbId}`,
  );
  return (data?.seasons ?? [])
    .filter((s) => Number(s.season_number) > 0 && Number(s.episode_count) > 0)
    .map((s) => ({
      number: Number(s.season_number),
      title: typeof s.name === "string" && s.name ? s.name : null,
    }));
}

async function tmdbSeasonEpisodes(
  config: Config,
  tmdbId: number,
  seasonNumber: number,
): Promise<TmdbEpisode[]> {
  const data = await tmdbGet<{ episodes?: Array<Record<string, unknown>> }>(
    config,
    `/tv/${tmdbId}/season/${seasonNumber}`,
  );
  return (data?.episodes ?? [])
    .filter((e) => Number(e.episode_number) > 0)
    .map((e) => ({
      number: Number(e.episode_number),
      title: typeof e.name === "string" && e.name ? e.name : null,
      runtime: (Number(e.runtime) || 0) * 60,
      thumbnailUrl:
        typeof e.still_path === "string" && e.still_path
          ? `https://image.tmdb.org/t/p/w300${e.still_path}`
          : null,
    }));
}

export async function hydrateSerialSeasons(
  db: Db,
  config: Config,
  itemId: number,
  tmdbId: number,
): Promise<boolean> {
  if (!tmdbId) return false;
  const missAt = hydrateMissedAt.get(tmdbId);
  if (missAt && Date.now() - missAt < HYDRATE_RETRY_MS) return false;

  const key = `${itemId}:${tmdbId}`;
  const pending = hydratePending.get(key);
  if (pending) return pending;

  const markMiss = (tmdbId: number) => {
    if (hydrateMissedAt.size > HYDRATE_MISSED_MAX) hydrateMissedAt.clear();
    hydrateMissedAt.set(tmdbId, Date.now());
  };

  const run = (async () => {
    const seasonList = await tmdbShowSeasons(config, tmdbId);
    if (seasonList.length === 0) {
      markMiss(tmdbId);
      return false;
    }
    let inserted = false;
    // Сезоны пачками по 4: у длинных сериалов десятки сезонов, а TMDb
    // любит 429 при десятках параллельных запросов.
    for (let i = 0; i < seasonList.length; i += 4) {
      const chunk = seasonList.slice(i, i + 4);
      const episodeLists = await Promise.all(
        chunk.map((s) => tmdbSeasonEpisodes(config, tmdbId, s.number)),
      );
      for (let j = 0; j < chunk.length; j++) {
        const meta = chunk[j]!;
        const eps = episodeLists[j] ?? [];
        if (eps.length === 0) continue;

        const [seasonRow] = await db
          .insert(seasons)
          .values({ itemId, number: meta.number, title: meta.title })
          .onConflictDoNothing({ target: [seasons.itemId, seasons.number] })
          .returning({ id: seasons.id });
        const seasonId =
          seasonRow?.id ??
          (
            await db
              .select({ id: seasons.id })
              .from(seasons)
              .where(
                and(eq(seasons.itemId, itemId), eq(seasons.number, meta.number)),
              )
              .limit(1)
          )[0]?.id;
        if (!seasonId) continue;

        const newEps = await db
          .insert(episodes)
          .values(
            eps.map((e) => ({
              seasonId,
              number: e.number,
              title: e.title,
              runtime: e.runtime,
              thumbnailUrl: e.thumbnailUrl,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: episodes.id, number: episodes.number, title: episodes.title });
        if (newEps.length > 0) {
          inserted = true;
          await db.insert(media).values(
            newEps.map((e) => ({
              itemId,
              episodeId: e.id,
              title: e.title ?? `Серия ${e.number}`,
              runtime: eps.find((x) => x.number === e.number)?.runtime ?? 0,
            })),
          );
        }
      }
    }
    if (inserted) {
      hydrateMissedAt.delete(tmdbId);
      // Трейлер тянем один раз вместе с сезонами: у сериалов из заливки его
      // тоже не было, а карточка без трейлера — половина карточки.
      const trailer = await tmdbTrailer(config, "tv", tmdbId).catch(() => null);
      if (trailer) {
        await applyEnrichment(db, itemId, {
          trailerId: trailer.id,
          trailerUrl: trailer.url,
        }).catch(() => undefined);
      }
    } else {
      markMiss(tmdbId);
    }
    return inserted;
  })();

  hydratePending.set(key, run);
  try {
    return await run;
  } finally {
    hydratePending.delete(key);
  }
}
