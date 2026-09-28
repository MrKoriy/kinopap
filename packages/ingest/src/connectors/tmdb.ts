/**
 * TmdbEnricher — легальный официальный TMDb API (api.themoviedb.org).
 * Тянет постеры, описания, оригинальные названия, рейтинги и трейлеры.
 * fetch инжектируется — тесты ходят в мок, не в сеть.
 */
import type { ItemType } from "@zal/api-client";
import type { Enrichment, EnrichmentQuery, MetadataEnricher } from "../types";

const TV_TYPES: readonly ItemType[] = ["serial", "docuserial", "tvshow"];

export interface TmdbEnricherOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  imageBaseUrl?: string;
}

interface TmdbSearchResult {
  id?: number;
  overview?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  poster_path?: string | null;
}

interface TmdbVideo {
  key?: string;
  site?: string;
  type?: string;
  official?: boolean;
  iso_639_1?: string;
}

/** Трейлер тайтла в каноничном виде: id ролика + ссылка на YouTube. */
export interface TmdbTrailer {
  id: string;
  url: string;
}

export class TmdbEnricher implements MetadataEnricher {
  readonly kind = "tmdb";

  constructor(private readonly opts: TmdbEnricherOptions) {}

  async find(query: EnrichmentQuery): Promise<Enrichment[]> {
    const isTv = TV_TYPES.includes(query.type);
    const url = new URL(
      `${this.opts.baseUrl ?? "https://api.themoviedb.org/3"}/search/${isTv ? "tv" : "movie"}`,
    );
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("query", query.title);
    if (query.year) {
      url.searchParams.set(isTv ? "first_air_date_year" : "year", String(query.year));
    }

    // Без таймаута зависший TMDb фейлил уже опубликованную задачу.
    const res = await (this.opts.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`tmdb: HTTP ${res.status}`);
    const data = (await res.json()) as { results?: TmdbSearchResult[] };

    const results = (data.results ?? []).slice(0, 5).map((r) => this.map(r));

    // Трейлер тянем только для лучшего совпадения (его и применяет pipeline):
    // лишний запрос на каждый ingest дешевле, чем трейлеры «где-то потом».
    const best = results[0];
    if (best?.tmdbId) {
      const trailer = await this.trailer({ type: query.type, tmdbId: best.tmdbId }).catch(
        () => null,
      );
      if (trailer) {
        best.trailerId = trailer.id;
        best.trailerUrl = trailer.url;
      }
    }

    return results;
  }

  /**
   * Трейлер тайтла: официальный YouTube-трейлер, при отсутствии — тизер.
   * Сначала русская дорожка, потом английская (у большинства фильмов
   * локализованного трейлера нет, а англоязычный лучше, чем ничего).
   */
  async trailer(input: { type: ItemType; tmdbId: number }): Promise<TmdbTrailer | null> {
    const isTv = TV_TYPES.includes(input.type);
    const base = this.opts.baseUrl ?? "https://api.themoviedb.org/3";
    const kind = isTv ? "tv" : "movie";

    for (const language of ["ru-RU", "en-US"]) {
      const url = new URL(`${base}/${kind}/${input.tmdbId}/videos`);
      url.searchParams.set("api_key", this.opts.apiKey);
      url.searchParams.set("language", language);
      const res = await (this.opts.fetch ?? fetch)(url, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: TmdbVideo[] };
      const picked = pickTrailer(data.results ?? []);
      if (picked) {
        return { id: picked, url: `https://www.youtube.com/watch?v=${picked}` };
      }
    }
    return null;
  }

  private map(r: TmdbSearchResult): Enrichment {
    const date = r.release_date ?? r.first_air_date ?? "";
    const year = Number(date.slice(0, 4));
    return {
      tmdbId: r.id ?? null,
      plot: r.overview?.trim() || null,
      originalTitle: r.original_title ?? r.original_name ?? null,
      year: Number.isFinite(year) && year > 0 ? year : null,
      tmdbRating: r.vote_average ?? null,
      tmdbVotes: r.vote_count ?? null,
      posterSmall: this.img(r.poster_path, "w185"),
      posterMedium: this.img(r.poster_path, "w500"),
      posterBig: this.img(r.poster_path, "original"),
    };
  }

  private img(posterPath: string | null | undefined, size: string): string | null {
    if (!posterPath) return null;
    const base = (this.opts.imageBaseUrl ?? "https://image.tmdb.org/t/p").replace(/\/$/, "");
    return `${base}/${size}${posterPath}`;
  }
}

/**
 * Выбор лучшего ролика: официальный трейлер > любой трейлер > тизер.
 * Возвращает только YouTube-ключи (Vimeo в iframe тоже играется, но
 * единый путь проще: все наши плееры знают YouTube).
 */
export function pickTrailer(videos: TmdbVideo[]): string | null {
  const youtube = videos.filter((v) => v.site === "YouTube" && v.key);
  const rank = (v: TmdbVideo): number => {
    const typeScore = v.type === "Trailer" ? 2 : v.type === "Teaser" ? 1 : 0;
    return typeScore * 2 + (v.official ? 1 : 0);
  };
  const best = youtube
    .filter((v) => rank(v) > 0)
    .sort((a, b) => rank(b) - rank(a))[0];
  return best?.key ?? null;
}
