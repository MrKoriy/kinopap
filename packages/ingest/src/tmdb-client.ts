/**
 * Единый клиент TMDb: пейсинг, ретраи на 429, baseUrl/api_key/imageBaseUrl —
 * знание о чужом API живёт здесь, а не в каждом потребителе.
 *
 * Два режима:
 *  - `get` — толерантный (fill каталога): любая неудача → null, fill едет дальше;
 *  - `getOrThrow` — строгий (энричер): HTTP-ошибка бросается со статусом,
 *    вызывающий код решает, fatal это или нет.
 */

import { fetchWithTimeout } from "./lib/http";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const TMDB_BASE_URL = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

export interface TmdbClientOptions {
  apiKey: string;
  baseUrl?: string;
  imageBaseUrl?: string;
  fetch?: typeof fetch;
  /** Пейсинг: минимальная пауза между запросами (TMDb лимит ~40 rps). */
  requestIntervalMs?: number;
  /** Таймаут одного запроса. */
  timeoutMs?: number;
  /** Язык ответов по умолчанию; null — не отправлять language вовсе. */
  language?: string | null;
}

export interface TmdbRequestOptions {
  /** Дополнительные query-параметры (query, year…). */
  params?: Record<string, string>;
  /** Язык этого запроса; null — не отправлять. По умолчанию — язык клиента. */
  language?: string | null;
}

export class TmdbClient {
  private nextAt = 0;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly imageBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly language: string | null;

  constructor(opts: TmdbClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? TMDB_BASE_URL).replace(/\/$/, "");
    this.imageBaseUrl = (opts.imageBaseUrl ?? TMDB_IMAGE_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.intervalMs = opts.requestIntervalMs ?? 0;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.language = opts.language !== undefined ? opts.language : "ru-RU";
  }

  /** URL картинки TMDb: постеры/стиллы по пути из ответа. */
  imageUrl(posterPath: string, size: string): string {
    return `${this.imageBaseUrl}/${size}${posterPath}`;
  }

  /** Толерантный GET: null вместо ошибки — 429/5xx не роняют fill. */
  async get<T = unknown>(path: string, opts: TmdbRequestOptions = {}): Promise<T | null> {
    try {
      const res = await this.raw(path, opts);
      if (!res?.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /** Строгий GET: HTTP-ошибка бросается со статусом. */
  async getOrThrow<T = unknown>(path: string, opts: TmdbRequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    if (!res) throw new Error("tmdb: request failed after retries");
    if (!res.ok) throw new Error(`tmdb: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Транспорт: пейсинг (очередь вместо «спим и дёргаемся» — держит ровный
   * темп), ретраи на 429 и сетевые ошибки. Итоговый Response (включая !ok)
   * отдаётся потребителю — толерантному или строгому.
   */
  private async raw(path: string, opts: TmdbRequestOptions): Promise<Response | null> {
    const now = Date.now();
    const start = Math.max(now, this.nextAt);
    this.nextAt = start + this.intervalMs;
    if (start > now) await sleep(start - now);

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("api_key", this.apiKey);
    const language = opts.language !== undefined ? opts.language : this.language;
    if (language) url.searchParams.set("language", language);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      url.searchParams.set(k, v);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchWithTimeout(url, this.timeoutMs, { fetchImpl: this.fetchFn });
        if (res.status === 429) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        return res;
      } catch {
        await sleep(500 * (attempt + 1));
      }
    }
    return null;
  }
}
