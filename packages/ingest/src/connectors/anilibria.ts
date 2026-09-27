/**
 * AniLibria connector for fast, legal anime streaming via direct HLS.
 * Compatible with anilibria.top/api/v1.
 */

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
}

export class AnilibriaConnector {
  private readonly baseUrl: string;

  constructor(baseUrl = "https://anilibria.top/api/v1") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async search(query: string): Promise<AnilibriaRelease[]> {
    const url = `${this.baseUrl}/anime/catalog/releases?search=${encodeURIComponent(query)}&limit=5`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: any[] };
      if (!json.data || !Array.isArray(json.data)) return [];

      return json.data.map((item) => ({
        id: item.id,
        title: item.name?.main ?? "",
        englishTitle: item.name?.english ?? undefined,
        year: item.year ?? 0,
        episodes: [],
        posterUrl: item.poster?.optimized?.src ? `https://anilibria.top${item.poster.optimized.src}` : undefined,
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  async getRelease(id: number): Promise<AnilibriaRelease | null> {
    const url = `${this.baseUrl}/anime/releases/${id}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      if (!data || !data.id) return null;

      const rawEpisodes: any[] = data.episodes ?? [];
      const episodes: AnilibriaEpisode[] = rawEpisodes.map((ep) => ({
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
        posterUrl: data.poster?.optimized?.src ? `https://anilibria.top${data.poster.optimized.src}` : undefined,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
