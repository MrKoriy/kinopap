/**
 * TmdbEnricher — легальный официальный TMDb API (api.themoviedb.org).
 * Тянет постеры, описания, оригинальные названия и рейтинги.
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

    const res = await (this.opts.fetch ?? fetch)(url);
    if (!res.ok) throw new Error(`tmdb: HTTP ${res.status}`);
    const data = (await res.json()) as { results?: TmdbSearchResult[] };

    return (data.results ?? []).slice(0, 5).map((r) => this.map(r));
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
