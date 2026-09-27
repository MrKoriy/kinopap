/**
 * Discovery: наполнение каталога из официального TMDb API.
 * Тренды недели + популярное (кино и сериалы), с дедупом против локального
 * каталога. Запускает владелец/админ — POST /v1/discover { pages?: 1..5 }.
 * Просмотр таких тайтлов — zero-storage: media-links резолвит стримы на лету.
 */

import { type Db, genres, itemGenres, items, media } from "@zal/db";
import { and, eq, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { forbidden, parseOrThrow } from "../lib/http";

const discoverBodySchema = z.object({
  pages: z.coerce.number().int().min(1).max(5).default(2),
});

/** TMDb (ru) → локальные названия жанров из сида. */
const GENRE_ALIASES: Record<string, string> = {
  "Боевик": "Боевик",
  "Приключения": "Приключения",
  "Анимация": "Мультфильм",
  "Комедия": "Комедия",
  "Преступление": "Криминал",
  "Документальный": "Документальный",
  "Драма": "Драма",
  "Семья": "Семейный",
  "Фэнтези": "Фэнтези",
  "История": "Исторический",
  "Ужасы": "Ужасы",
  "Музыка": "Мюзикл",
  "Детектив": "Детектив",
  "Романтика": "Мелодрама",
  "Фантастика": "Фантастика",
  "Триллер": "Триллер",
  "Война": "Военный",
  "Вестерн": "Вестерн",
  "Аниме": "Аниме",
  "Мультфильм": "Мультфильм",
  "Криминал": "Криминал",
};

interface TmdbEntry {
  tmdbId: number;
  type: "movie" | "serial";
  title: string;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  rating: number;
  votes: number;
  runtime: number | null;
  posterSmall: string | null;
  posterMedium: string | null;
  posterBig: string | null;
  genreIds: number[];
}

async function tmdbGet(config: Config, path: string): Promise<unknown | null> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", config.tmdbApiKey!);
  url.searchParams.set("language", "ru-RU");
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return res.json();
}

function mapEntry(
  raw: Record<string, unknown>,
  type: "movie" | "serial",
): TmdbEntry | null {
  const tmdbId = typeof raw.id === "number" ? raw.id : null;
  const title = String(raw.title ?? raw.name ?? "").trim();
  const posterPath = raw.poster_path ? String(raw.poster_path) : null;
  const votes = typeof raw.vote_count === "number" ? raw.vote_count : 0;
  if (!tmdbId || !title || !posterPath || votes < 50) return null;

  const date = String(raw.release_date ?? raw.first_air_date ?? "");
  const year = date.length >= 4 ? parseInt(date.slice(0, 4), 10) : null;
  const runtimeRaw =
    type === "movie"
      ? raw.runtime
      : Array.isArray(raw.episode_run_time)
        ? raw.episode_run_time[0]
        : null;

  const voteAvg = typeof raw.vote_average === "number" ? raw.vote_average : 0;

  return {
    tmdbId,
    type,
    title,
    originalTitle: raw.original_title ?? raw.original_name
      ? String(raw.original_title ?? raw.original_name)
      : null,
    year: year && year > 1900 ? year : null,
    plot: raw.overview ? String(raw.overview) : null,
    rating: voteAvg > 0 ? Math.round(voteAvg * 10) / 10 : 0,
    votes,
    runtime: typeof runtimeRaw === "number" && runtimeRaw > 0 ? runtimeRaw * 60 : null,
    posterSmall: `https://image.tmdb.org/t/p/w185${posterPath}`,
    posterMedium: `https://image.tmdb.org/t/p/w500${posterPath}`,
    posterBig: `https://image.tmdb.org/t/p/original${posterPath}`,
    genreIds: Array.isArray(raw.genre_ids)
      ? raw.genre_ids.filter((g): g is number => typeof g === "number")
      : [],
  };
}

async function collectEntries(
  config: Config,
  pages: number,
): Promise<TmdbEntry[]> {
  const byKey = new Map<string, TmdbEntry>();
  const push = (e: TmdbEntry | null) => {
    if (e) byKey.set(`${e.type}:${e.tmdbId}`, e);
  };

  const lists: string[] = ["/trending/movie/week", "/trending/tv/week"];
  for (let p = 1; p <= pages; p++) {
    lists.push(`/movie/popular?page=${p}`, `/tv/popular?page=${p}`);
  }

  for (const path of lists) {
    try {
      const data = (await tmdbGet(config, path)) as
        | { results?: Array<Record<string, unknown>> }
        | null;
      const isTv = path.includes("/tv");
      for (const raw of data?.results ?? []) {
        push(mapEntry(raw, isTv ? "serial" : "movie"));
      }
    } catch {
      // Один недоступный список не должен ронять весь discovery.
    }
  }
  return [...byKey.values()];
}

export async function discoveryRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config },
): Promise<void> {
  const { db, config } = deps;

  app.post(
    "/discover",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    },
    async (request) => {
      if (request.user.role !== "owner" && request.user.role !== "admin") {
        throw forbidden("Discovery is available to owner/admin only");
      }
      if (!config.tmdbApiKey) {
        throw forbidden("TMDB_API_KEY is not configured on the server");
      }

      const body = parseOrThrow(discoverBodySchema, request.body ?? {});

      const entries = await collectEntries(config, body.pages);

      // Локальные жанры + карта TMDb genre_id → локальный genre_id.
      const genreRows = await db.select().from(genres);
      const byTitle = new Map(genreRows.map((g) => [g.title, g.id]));
      const tmdbGenreIds = new Map<number, number | null>();
      for (const kind of ["movie", "tv"] as const) {
        try {
          const list = (await tmdbGet(config, `/genre/${kind}/list`)) as
            | { genres?: Array<{ id?: number; name?: string }> }
            | null;
          for (const g of list?.genres ?? []) {
            if (typeof g.id !== "number") continue;
            const local = byTitle.get(GENRE_ALIASES[g.name ?? ""] ?? g.name ?? "");
            tmdbGenreIds.set(g.id, local ?? null);
          }
        } catch {
          // Без жанровых связей discovery всё равно валиден.
        }
      }

      let added = 0;
      let updated = 0;
      let skipped = 0;

      for (const e of entries) {
        // Дедуп: по tmdbId либо по (title, year).
        const dup = await db
          .select({ id: items.id, poster: items.posterMedium })
          .from(items)
          .where(
            or(
              eq(items.tmdbId, e.tmdbId),
              e.year != null
                ? and(sql`${items.title} ilike ${e.title}`, eq(items.year, e.year))
                : sql`${items.title} ilike ${e.title}`,
            ),
          )
          .limit(1);

        const existing = dup[0];
        if (existing) {
          // Уже в каталоге, но без постера (битые URL сида) — чиним метаданные.
          if (!existing.poster && e.posterMedium) {
            await db
              .update(items)
              .set({
                posterSmall: e.posterSmall,
                posterMedium: e.posterMedium,
                posterBig: e.posterBig,
                plot: e.plot,
                originalTitle: e.originalTitle,
                rating: e.rating > 0 ? e.rating : undefined,
                tmdbId: e.tmdbId,
                updatedAt: new Date(),
              })
              .where(eq(items.id, existing.id));
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        const [inserted] = await db
          .insert(items)
          .values({
            type: e.type,
            title: e.title,
            originalTitle: e.originalTitle,
            year: e.year,
            plot: e.plot,
            rating: e.rating,
            quality: 1080,
            posterSmall: e.posterSmall,
            posterMedium: e.posterMedium,
            posterBig: e.posterBig,
            tmdbId: e.tmdbId,
          })
          .returning({ id: items.id });
        if (!inserted) continue;

        const genreIds = [...new Set(e.genreIds.map((g) => tmdbGenreIds.get(g) ?? null).filter((g): g is number => g != null))];
        for (const gid of genreIds) {
          await db
            .insert(itemGenres)
            .values({ itemId: inserted.id, genreId: gid })
            .onConflictDoNothing();
        }

        await db.insert(media).values({
          itemId: inserted.id,
          title: e.title,
          runtime: e.runtime ?? 0,
        });
        added++;
      }

      return { added, updated, skipped, total: entries.length };
    },
  );
}
