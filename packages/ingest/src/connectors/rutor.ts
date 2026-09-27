/**
 * Rutor torrent search connector.
 * Direct search on rutor.info / mirrors with zero external dependencies.
 */

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

export class RutorConnector {
  private readonly mirrors: string[];

  constructor(mirrors: string[] = ["https://rutor.is", "https://rutor.info", "http://rutor.info"]) {
    this.mirrors = mirrors;
  }

  async search(query: string, category: RutorCategory = "all"): Promise<RutorRelease[]> {
    const catId = CATEGORY_MAP[category] ?? 0;
    let lastError: unknown = null;

    for (const mirror of this.mirrors) {
      const url = `${mirror}/search/0/${catId}/2/0/${encodeURIComponent(query)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });

        if (!res.ok) continue;

        const html = await res.text();
        const parsed = this.parseHtml(html);
        if (parsed.length > 0) return parsed;
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (lastError) {
      // Return empty results gracefully rather than crashing if trackers are blocked
      return [];
    }
    return [];
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
