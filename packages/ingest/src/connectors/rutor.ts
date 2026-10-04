/**
 * Rutor torrent search connector.
 * Direct search on rutor.info / mirrors with zero external dependencies.
 */
import { fetchWithTimeout } from "../lib/http";

export interface RutorRelease {
  title: string;
  hash: string;
  magnet: string;
  size: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  quality: string;
  dub: string | null;
  year: number | null;
  category: string | null;
}

export type RutorCategory = "all" | "foreign-movies" | "domestic-movies" | "foreign-series" | "domestic-series" | "animation" | "anime";

const CATEGORY_MAP: Record<RutorCategory, number> = {
  all: 0,
  "foreign-movies": 1,
  "domestic-movies": 5,
  "foreign-series": 4,
  "domestic-series": 16,
  animation: 7,
  anime: 10,
};

function parseSizeBytes(str: string): number {
  const match = str.match(/([\d.]+)\s*(GB|MB|KB|B)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  switch (unit) {
    case "GB":
      return Math.round(val * 1024 * 1024 * 1024);
    case "MB":
      return Math.round(val * 1024 * 1024);
    case "KB":
      return Math.round(val * 1024);
    default:
      return Math.round(val);
  }
}

function detectQuality(title: string): string {
  if (/2160p|4k|uhd/i.test(title)) return "4K (2160p)";
  if (/remux/i.test(title)) return "1080p Remux";
  if (/1080p/i.test(title)) return "1080p";
  if (/720p/i.test(title)) return "720p";
  if (/bdrip|bluray/i.test(title)) return "BDRip";
  if (/web-dl|webrip/i.test(title)) return "WEB-DL";
  if (/hdtv/i.test(title)) return "HDTV";
  return "SD";
}

function detectDub(title: string): string | null {
  const tags: string[] = [];
  if (/\b(d|дубляж)\b/i.test(title)) tags.push("Дубляж");
  if (/\blostfilm\b/i.test(title)) tags.push("LostFilm");
  if (/\bhdrezka\b/i.test(title)) tags.push("HDRezka");
  if (/\bred head sound\b/i.test(title)) tags.push("Red Head Sound");
  if (/\bnewstudio\b/i.test(title)) tags.push("NewStudio");
  if (/\b(itunes|пифагор)\b/i.test(title)) tags.push("iTunes");
  if (/\b(p|пкс|проф)\b/i.test(title) && !tags.includes("Дубляж")) tags.push("Закадровый");
  if (/\b(a|авторский)\b/i.test(title)) tags.push("Авторский");
  if (/\b(sub|субтитры)\b/i.test(title)) tags.push("Субтитры");
  return tags.length > 0 ? tags.join(", ") : null;
}

function detectYear(title: string): number | null {
  const match = title.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Внешнее KV-хранилище для кэша поиска (Redis в проде). Интерфейс узкий,
 * чтобы ingest не зависел от ioredis: API и воркер передают свою обёртку.
 */
export interface SearchCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Сколько живёт непустая выдача rutor: раздачи не исчезают за часы,
 * а сиды в кэше чуть отстают — для скоринга это не критично. */
const SEARCH_HIT_TTL_S = 6 * 60 * 60;
/** Пустая выдача живёт коротко: релиз могут залить в любой момент. */
const SEARCH_EMPTY_TTL_S = 20 * 60;
const SEARCH_CACHE_PREFIX = "rutor:search:v1:";

export class RutorConnector {
  private readonly mirrors: string[];
  private cache: SearchCache | null = null;

  constructor(mirrors: string[] = ["https://rutor.is", "https://rutor.info", "http://rutor.info"]) {
    this.mirrors = mirrors;
  }

  /** Подключить общий кэш выдачи (общий для процессов, переживает рестарт). */
  setCache(cache: SearchCache | null): void {
    this.cache = cache;
  }

  async search(query: string, category: RutorCategory = "all"): Promise<RutorRelease[]> {
    const cache = this.cache;
    if (!cache) return (await this.searchLive(query, category)).releases;

    const key = `${SEARCH_CACHE_PREFIX}${category}:${query.toLowerCase()}`;
    try {
      const hit = await cache.get(key);
      if (hit != null) return JSON.parse(hit) as RutorRelease[];
    } catch {
      // Кэш недоступен — идём на трекер, как без кэша.
    }

    const { releases, failed } = await this.searchLive(query, category);
    // Сбой всех зеркал не кэшируем: следующий запрос должен попробовать снова.
    if (!failed) {
      const ttl = releases.length > 0 ? SEARCH_HIT_TTL_S : SEARCH_EMPTY_TTL_S;
      void cache.set(key, JSON.stringify(releases), ttl).catch(() => {});
    }
    return releases;
  }

  private async searchLive(
    query: string,
    category: RutorCategory,
  ): Promise<{ releases: RutorRelease[]; failed: boolean }> {
    const catId = CATEGORY_MAP[category] ?? 0;
    let lastError: unknown = null;
    let answered = false;

    for (const mirror of this.mirrors) {
      const url = `${mirror}/search/0/${catId}/2/0/${encodeURIComponent(query)}`;

      try {
        const res = await fetchWithTimeout(url, 4000, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });

        if (!res.ok) continue;

        const html = await res.text();
        answered = true;
        const parsed = this.parseHtml(html);
        if (parsed.length > 0) return { releases: parsed, failed: false };
      } catch (err) {
        lastError = err;
      }
    }

    // Трекер недоступен (таймаут/сеть) — отдаём пустой результат, резолв
    // откатывается на остальные источники.
    if (lastError) {
      console.warn(
        `rutor: search "${query}" failed on all mirrors:`,
        String(lastError).slice(0, 200),
      );
    }
    return { releases: [], failed: !answered };
  }

  parseHtml(html: string): RutorRelease[] {
    const rows = html.split(/<tr class="(?:gai|tum)">/);
    const results: RutorRelease[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const magnetMatch = row.match(/href="(magnet:\?xt=urn:btih:([a-zA-Z0-9]+)[^"]*)"/);
      const titleMatch = row.match(/<a href="\/torrent\/\d+\/[^"]+">([^<]+)<\/a>/);
      const sizeMatch = row.match(/<td align="right">([\d.]+(?:&nbsp;|\s+)(?:GB|MB|KB|B))<\/td>/i);
      const seedersMatch = row.match(/<span class="green"[^>]*>[\s\S]*?(\d+)\s*<\/span>/i);
      const leechersMatch = row.match(/<span class="red"[^>]*>[\s\S]*?(\d+)\s*<\/span>/i);

      if (magnetMatch && titleMatch) {
        const rawTitle = titleMatch[1]
          .replace(/&#039;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .trim();
        const sizeStr = sizeMatch ? sizeMatch[1].replace(/&nbsp;/g, " ") : "0 B";
        const seeds = seedersMatch ? parseInt(seedersMatch[1], 10) : 0;
        const peers = leechersMatch ? parseInt(leechersMatch[1], 10) : 0;

        results.push({
          title: rawTitle,
          hash: magnetMatch[2].toLowerCase(),
          magnet: magnetMatch[1],
          size: sizeStr,
          sizeBytes: parseSizeBytes(sizeStr),
          seeds,
          peers,
          quality: detectQuality(rawTitle),
          dub: detectDub(rawTitle),
          year: detectYear(rawTitle),
          category: null,
        });
      }
    }

    return results;
  }
}
