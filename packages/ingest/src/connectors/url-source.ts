/**
 * UrlSource: прямая ссылка на файл. Скачивает СТРИМОМ на диск (многогигабайтные
 * файлы раньше читались целиком в память → OOM воркера), с лимитом размера,
 * таймаутами и SSRF-guard (allowlist схем, блокировка приватных адресов,
 * лимит редиректов). probe умеет и по URL (ffprobe поддерживает http).
 * У ссылки нет каталога — search возвращает пусто; плагины с реальными
 * источниками реализуют search сами.
 */

import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type FfmpegConfig, probeMedia } from "../media/probe";
import type {
  PulledSource,
  PullOptions,
  SourceConnector,
  SourceEntry,
  SourceInfo,
  SourceQuery,
} from "../types";

export interface UrlSourceOptions extends FfmpegConfig {
  fetch?: typeof fetch;
  /**
   * true — разрешить http(s) на приватные адреса (LAN/NAS/self-hosted).
   * По умолчанию заблокированы: без этого URL-ингест зондирует внутренние
   * сервисы (Redis, Postgres, metadata-эндпоинты облака).
   */
  allowPrivateHosts?: boolean;
  /** Потолок скачивания, байт (по умолчанию 20 ГБ). */
  maxBytes?: number;
  /** Общий таймаут скачивания, мс (по умолчанию 2 часа). */
  downloadTimeoutMs?: number;
  /** Таймаут отсутствия данных: stalled-соединение прибивается, мс. */
  stallTimeoutMs?: number;
  /** Максимум HTTP-редиректов. */
  maxRedirects?: number;
}

export class UrlSourceConnector implements SourceConnector {
  readonly kind = "url" as const;

  constructor(private readonly cfg: UrlSourceOptions = {}) {}

  async search(_query: SourceQuery): Promise<SourceEntry[]> {
    return [];
  }

  async probe(ref: string): Promise<SourceInfo> {
    // URL уходит в ffprobe — та же поверхность, что и у скачивания.
    await assertSafeUrl(ref, this.cfg);
    return probeMedia(ref, this.cfg);
  }

  async pull(ref: string, opts: PullOptions): Promise<PulledSource> {
    const filePath = await download(this.cfg, ref, opts.workDir);
    const subtitlePaths = [];
    for (const sub of opts.subtitleRefs ?? []) {
      subtitlePaths.push({
        path: await download(this.cfg, sub, opts.workDir),
        lang: null,
      });
    }
    return { filePath, subtitlePaths, cleanup: async () => {} };
  }
}

/* ---------- SSRF guard ---------- */

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
];

function isPrivateIp(ip: string): boolean {
  if (PRIVATE_V4.some((re) => re.test(ip))) return true;
  if (ip === "::1" || ip === "::") return true;
  const lower = ip.toLowerCase();
  // fc00::/7 (ULA) и fe80::/10 (link-local).
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:10.0.0.1).
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return PRIVATE_V4.some((re) => re.test(mapped[1]!));
  return false;
}

/**
 * Схема обязана быть http/https, хост не резолвится в приватный адрес,
 * порт не попадает на внутренние сервисы. DNS-ребиндинг остаётся
 * теоретическим окном (проверка до запроса, не во время) — для этого
 * этапа достаточно.
 */
export async function assertSafeUrl(raw: string, cfg: UrlSourceOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`url source: not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`url source: only http(s) allowed, got ${url.protocol}`);
  }
  if (cfg.allowPrivateHosts) return url;

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if ([22, 23, 5432, 5433, 6379, 9200, 11211, 27017].includes(port)) {
    throw new Error(`url source: suspicious port ${port}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  try {
    const records = await lookup(hostname, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        throw new Error(
          `url source: private address ${r.address} is blocked (set allowPrivateHosts for LAN sources)`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("url source:")) throw err;
    // Нерезолвящийся хост оставляем fetch'у — он честно вернёт ошибку.
  }
  return url;
}

/* ---------- Скачивание ---------- */

async function download(cfg: UrlSourceOptions, rawUrl: string, workDir: string): Promise<string> {
  const url = await assertSafeUrl(rawUrl, cfg);
  const name = path.basename(url.pathname) || "source.bin";

  const maxBytes = cfg.maxBytes ?? 20 * 1024 * 1024 * 1024;
  const overallTimeoutMs = cfg.downloadTimeoutMs ?? 2 * 60 * 60 * 1000;
  const stallTimeoutMs = cfg.stallTimeoutMs ?? 60_000;
  const maxRedirects = cfg.maxRedirects ?? 3;

  const doFetch = cfg.fetch ?? fetch;
  const filePath = path.join(workDir, name);
  const out = createWriteStream(filePath);

  const overallAbort = new AbortController();
  let stalled = false;
  const overallTimer = setTimeout(() => overallAbort.abort(), overallTimeoutMs);

  // Тикающий стайл-таймер: нет данных N мс — соединение мертво.
  let stallTimer: NodeJS.Timeout | null = null;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      overallAbort.abort();
    }, stallTimeoutMs);
  };
  const disarmStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  armStall();

  try {
    let currentUrl: string = url.toString();
    for (let redirect = 0; redirect <= maxRedirects; redirect++) {
      const res = await doFetch(currentUrl, {
        signal: overallAbort.signal,
        redirect: "manual",
      });
      // Ручные редиректы: лимит + каждый Location проходит тот же guard.
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) throw new Error("url source: redirect without Location");
        const next = await assertSafeUrl(new URL(location, currentUrl).toString(), cfg);
        currentUrl = next.toString();
        continue;
      }
      if (!res.ok) throw new Error(`url source: HTTP ${res.status} for ${currentUrl}`);
      if (!res.body) throw new Error("url source: empty body");

      let received = 0;
      const body = res.body as ReadableStream<Uint8Array>;
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            armStall();
            received += chunk.byteLength;
            if (received > maxBytes) {
              controller.error(
                new Error(`url source: size limit ${maxBytes} bytes exceeded`),
              );
              return;
            }
            controller.enqueue(chunk);
          },
        }),
      );

      // Стримим на диск: память не растёт с размером файла.
      await pipeline(Readable.fromWeb(counted as never), out);
      disarmStall();
      return filePath;
    }
    throw new Error(`url source: too many redirects (>${maxRedirects})`);
  } catch (err) {
    // Недокачанный файл — мусор: закрываем поток и убираем с диска.
    out.destroy();
    await unlink(filePath).catch(() => {});
    if (stalled) throw new Error(`url source: stalled (no data for ${stallTimeoutMs}ms)`);
    if (overallAbort.signal.aborted && !stalled) {
      throw new Error(`url source: download timeout (${overallTimeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(overallTimer);
    disarmStall();
  }
}
