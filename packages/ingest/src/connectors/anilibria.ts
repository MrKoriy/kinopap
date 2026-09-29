/**
 * AniLibria connector for fast, legal anime streaming via direct HLS.
 * Compatible with anilibria.top/api/v1.
 */
import { fetchWithTimeout } from "../lib/http";

export interface AnilibriaEpisode {
  id: string;
  name: string;
  ordinal: number;
  duration: number;
  introStart?: number;
  introStop?: number;
  hls1080?: string;
  hls720?: string;
  hls480?: string;
}

export interface AnilibriaRelease {
  id: number;
  title: string;
  englishTitle?: string;
  year: number;
  episodes: AnilibriaEpisode[];
  posterUrl?: string;
  plot?: string | null;
}

export interface AnilibriaCatalogRelease {
  id: number;
  title: string;
  englishTitle: string | null;
  year: number | null;
  posterUrl: string | null;
  plot: string | null;
}

export interface AnilibriaCatalogPage {
  releases: AnilibriaCatalogRelease[];
  /** 0 — источник не сообщил (тогда листинг стопаем по пустой странице). */
  totalPages: number;
}

/** Пункт поисковой выдачи каталога — только читаемые поля. */
interface SearchItem {
  id?: number;
  name?: { main?: string; english?: string };
  year?: number;
  poster?: { optimized?: { src?: string } };
}

interface SearchResponse {
  data?: SearchItem[];
}

/** Ответ /anime/releases/:id — только читаемые поля. */
interface EpisodeResponse {
  id?: number | string;
  ordinal?: number;
  name?: string;
  duration?: number;
  opening?: { start?: number; stop?: number };
  hls_1080?: string;
  hls_720?: string;
  hls_480?: string;
}

interface ReleaseResponse {
  id?: number;
  name?: { main?: string; english?: string };
  year?: number;
  episodes?: EpisodeResponse[];
  poster?: { optimized?: { src?: string } };
  description?: string;
  plot?: string;
}

function absPoster(poster: unknown): string | null {
  const src = (poster as { optimized?: { src?: unknown } } | undefined)?.optimized?.src;
  if (typeof src !== "string" || !src) return null;
  return src.startsWith("http") ? src : `https://anilibria.top${src}`;
}

export class AnilibriaConnector {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl = "https://anilibria.top/api/v1", fetchFn?: typeof fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchFn = fetchFn ?? fetch;
  }

  /**
   * Страница каталога: листинг релизов для импорта в каталог.
   * Формат пагинации у источника плавает — читаем всё, что похоже на число
   * страниц, и откатываемся на «до первой пустой».
   */
  async listReleases(page: number, limit = 50): Promise<AnilibriaCatalogPage> {
    const url = `${this.baseUrl}/anime/catalog/releases?page=${page}&limit=${limit}`;
    try {
      const res = await fetchWithTimeout(url, 8000, {
        headers: { "User-Agent": "Mozilla/5.0" },
        fetchImpl: this.fetchFn,
      });
      if (!res.ok) return { releases: [], totalPages: 0 };
      const json = (await res.json()) as unknown;
      const obj: Record<string, unknown> = Array.isArray(json)
        ? {}
        : ((json ?? {}) as Record<string, unknown>);
      const data = Array.isArray(json)
        ? json
        : Array.isArray(obj.data)
          ? obj.data
          : [];
      const pag = (() => {
        // Формат плавает: пагинация лежит то в корне, то в meta.pagination
        // ({"meta":{"pagination":{"total_pages":39}}} — так отдаёт каталог).
        const meta = (obj.meta ?? {}) as Record<string, unknown>;
        return ((obj.pagination ?? meta.pagination ?? {}) ?? {}) as Record<string, unknown>;
      })();
      const rawTotal = pag.total_pages ?? pag.pages ?? pag.last_page ?? obj.last_page;
      const totalPages = typeof rawTotal === "number" ? rawTotal : Number(rawTotal ?? 0) || 0;

      return {
        releases: data.flatMap((raw) => {
          const item = raw as Record<string, unknown>;
          const id = typeof item.id === "number" ? item.id : null;
          const name = item.name as { main?: unknown; english?: unknown } | undefined;
          const title = String(name?.main ?? "").trim();
          if (!id || !title) return [];
          const year = typeof item.year === "number" ? item.year : null;
          const description = item.description ?? item.plot;
          return [
            {
              id,
              title,
              englishTitle: name?.english ? String(name.english) : null,
              year: year && year > 1900 ? year : null,
              posterUrl: absPoster(item.poster),
              plot: description ? String(description) : null,
            } satisfies AnilibriaCatalogRelease,
          ];
        }),
        totalPages,
      };
    } catch {
      return { releases: [], totalPages: 0 };
    }
  }

  async search(query: string): Promise<AnilibriaRelease[]> {
    const url = `${this.baseUrl}/anime/catalog/releases?search=${encodeURIComponent(query)}&limit=5`;

    try {
      const res = await fetchWithTimeout(url, 6000, {
        headers: { "User-Agent": "Mozilla/5.0" },
        fetchImpl: this.fetchFn,
      });
      if (!res.ok) return [];
      const json = (await res.json()) as SearchResponse;
      if (!json.data || !Array.isArray(json.data)) return [];

      return json.data.map((item) => ({
        id: item.id ?? 0,
        title: item.name?.main ?? "",
        englishTitle: item.name?.english ?? undefined,
        year: item.year ?? 0,
        episodes: [],
        posterUrl: item.poster?.optimized?.src
          ? `https://anilibria.top${item.poster.optimized.src}`
          : undefined,
      }));
    } catch {
      return [];
    }
  }

  async getRelease(id: number): Promise<AnilibriaRelease | null> {
    const url = `${this.baseUrl}/anime/releases/${id}`;

    try {
      const res = await fetchWithTimeout(url, 8000, {
        headers: { "User-Agent": "Mozilla/5.0" },
        fetchImpl: this.fetchFn,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as ReleaseResponse;
      if (!data?.id) return null;

      const episodes: AnilibriaEpisode[] = (data.episodes ?? []).map((ep) => ({
        id: String(ep.id ?? ep.ordinal),
        name: ep.name ?? `Серия ${ep.ordinal}`,
        ordinal: ep.ordinal ?? 1,
        duration: ep.duration ?? 0,
        introStart: ep.opening?.start,
        introStop: ep.opening?.stop,
        hls1080: ep.hls_1080 ?? undefined,
        hls720: ep.hls_720 ?? undefined,
        hls480: ep.hls_480 ?? undefined,
      }));

      return {
        id: data.id,
        title: data.name?.main ?? "",
        englishTitle: data.name?.english ?? undefined,
        year: data.year ?? 0,
        episodes,
        posterUrl: absPoster(data.poster) ?? undefined,
        plot: data.description ?? data.plot ?? null,
      };
    } catch {
      return null;
    }
  }
}
