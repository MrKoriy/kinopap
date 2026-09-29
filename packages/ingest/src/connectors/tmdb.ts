/**
 * TmdbEnricher — легальный официальный TMDb API (api.themoviedb.org).
 * Тянет постеры, описания, оригинальные названия, рейтинги и трейлеры.
 * fetch инжектируется — тесты ходят в мок, не в сеть.
 *
 * Транспорт общий с fill'ом каталога (tmdb-client.ts): пейсинг, ретраи на
 * 429 и знание baseUrl/api_key — в одном месте. Поиск идёт без language
 * (как и раньше), трейлеры — ru-RU → en-US.
 */
import type { ItemType } from "@zal/api-client";
import { TmdbClient } from "../tmdb-client";
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

  private readonly client: TmdbClient;

  constructor(opts: TmdbEnricherOptions) {
    this.client = new TmdbClient({
      apiKey: opts.apiKey,
      fetch: opts.fetch,
      baseUrl: opts.baseUrl,
      imageBaseUrl: opts.imageBaseUrl,
      // Энричер ходит в TMDb точечно (1-3 запроса на ingest): пейсинг не нужен,
      // ошибки — non-fatal на уровне pipeline, поэтому строгий режим.
      requestIntervalMs: 0,
      timeoutMs: 8000,
      // Поиск по названию идёт без language — как исторически: матчатся
      // названия, а не локализация выдачи.
      language: null,
    });
  }

  async find(query: EnrichmentQuery): Promise<Enrichment[]> {
    const isTv = TV_TYPES.includes(query.type);
    const params: Record<string, string> = { query: query.title };
    if (query.year) {
      params[isTv ? "first_air_date_year" : "year"] = String(query.year);
    }
    const data = await this.client.getOrThrow<{ results?: TmdbSearchResult[] }>(
      `/search/${isTv ? "tv" : "movie"}`,
      { params },
    );

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
    const kind = isTv ? "tv" : "movie";

    for (const language of ["ru-RU", "en-US"]) {
      const data = await this.client.get<{ results?: TmdbVideo[] }>(
        `/${kind}/${input.tmdbId}/videos`,
        { language },
      );
      const picked = data && pickTrailer(data.results ?? []);
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
    return this.client.imageUrl(posterPath, size);
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
