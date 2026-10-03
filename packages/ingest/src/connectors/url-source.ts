/**
 * UrlSource: прямая ссылка на файл. Скачивает СТРИМОМ на диск (многогигабайтные
 * файлы раньше читались целиком в память → OOM воркера), с лимитом размера,
 * таймаутами и SSRF-guard (allowlist схем, блокировка приватных адресов,
 * лимит редиректов). probe умеет и по URL (ffprobe поддерживает http).
 * У ссылки нет каталога — search возвращает пусто; плагины с реальными
 * источниками реализуют search сами.
 */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
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
    // URL уходит в ffprobe — та же поверхность, что и у скачивания. ffprobe сам
    // ходит по редиректам и по ссылкам внутри плейлистов, поэтому: 1) цепочку
    // редиректов проходим заранее через guard и отдаём ему финальный URL;
    // 2) запрещаем всё, кроме http(s), — никаких file:/concat:/data: из HLS.
    const finalUrl = await resolveRedirects(this.cfg, ref);
    return probeMedia(finalUrl, this.cfg, [
      "-protocol_whitelist", "http,https,tcp,tls",
    ]);
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

/**
 * Всё, что не является публичным unicast: loopback, RFC1918, CGNAT
 * (100.64/10), link-local, документационные/бенчмарк-сети, multicast,
 * reserved. Проверка через node:net.BlockList — без самодельных регэкспов.
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

function decodeIpv4Octet(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("0x")) {
    const n = Number.parseInt(s, 16);
    return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
  }
  if (/^0[0-7]+$/.test(s) && s !== "0") {
    const n = Number.parseInt(s, 8);
    return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
  }
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
}

/** 0x7f000001 / 2130706433 / 0177.0.0.1 → «127.0.0.1». */
function normalizeIpv4(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
  }
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    const n = Number.parseInt(trimmed, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
  }
  const parts = trimmed.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    const v = decodeIpv4Octet(part);
    if (v == null) return null;
    octets.push(v);
  }
  return octets.join(".");
}

/** IPv6 → 16 байт (поддерживает «::» и хвост в dotted-quad). */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2]!.split(".").map(Number);
    s = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes;
}

const v4 = (b: number[], at: number) => b.slice(at, at + 4).join(".");

/**
 * IPv4, спрятанный внутри IPv6: mapped (::ffff:a.b.c.d), compat (::a.b.c.d),
 * NAT64 (64:ff9b::/96, 64:ff9b:1::/48), 6to4 (2002:AABB:CCDD::/16).
 * Без этого [::ffff:127.0.0.1] и [64:ff9b::7f00:1] проходили guard.
 */
function embeddedIpv4(b: number[]): string | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(b, 12);
  if (zero(0, 12)) return v4(b, 12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return v4(b, 12);
    if (b[4] === 0x00 && b[5] === 0x01) return v4(b, 12);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return v4(b, 2);
  return null;
}

/** true — адрес не публичный (или не распарсился: fail closed). */
export function isPrivateIp(raw: string): boolean {
  const s = raw.trim().replace(/^\[|\]$/g, "");
  const asV4 = normalizeIpv4(s);
  if (asV4) return BLOCKED.check(asV4, "ipv4");
  if (isIP(s.replace(/%.*$/, "")) !== 6) return true;
  const bytes = ipv6Bytes(s);
  if (!bytes) return true;
  const inner = embeddedIpv4(bytes);
  if (inner && BLOCKED.check(inner, "ipv4")) return true;
  return BLOCKED.check(s.replace(/%.*$/, ""), "ipv6");
}

/** Хост — IP-литерал в любой форме (включая 0x/десятичную/IPv6)? */
function isIpLiteral(host: string): boolean {
  return normalizeIpv4(host) != null || isIP(host) === 6;
}

/**
 * Схема обязана быть http/https, хост не резолвится в приватный адрес,
 * порт не попадает на внутренние сервисы. DNS-ребиндинг остаётся теоретическим окном: проверка до запроса
 * не фиксирует IP на соединении. Полная защита — пиновать resolved IP
 * на fetch (lookup → fetch к IP с Host-заголовком); для текущего этапа
 * достаточно блокировки приватных адресов до и после DNS.
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
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new Error(`url source: private address ${hostname} is blocked (set allowPrivateHosts for LAN sources)`);
  }
  // IP-литерал (включая 0x/десятичную форму и IPv6) — решаем без DNS.
  if (isIpLiteral(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`url source: private address ${hostname} is blocked (set allowPrivateHosts for LAN sources)`);
    }
    return url;
  }
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

/* ---------- Редиректы для ffprobe ---------- */

/**
 * Проходит цепочку редиректов вручную (каждый Location — через guard) и
 * возвращает финальный URL. Нужен для probe: ffprobe следует редиректам сам,
 * и без этого публичный URL с 302 на http://127.0.0.1 обходил защиту.
 */
export async function resolveRedirects(cfg: UrlSourceOptions, rawUrl: string): Promise<string> {
  let current = (await assertSafeUrl(rawUrl, cfg)).toString();
  if (cfg.allowPrivateHosts) return current;
  const doFetch = cfg.fetch ?? fetch;
  const maxRedirects = cfg.maxRedirects ?? 3;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await doFetch(current, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => {});
    if (![301, 302, 303, 307, 308].includes(res.status)) return current;
    const location = res.headers.get("location");
    if (!location) throw new Error("url source: redirect without Location");
    current = (await assertSafeUrl(new URL(location, current).toString(), cfg)).toString();
  }
  throw new Error(`url source: too many redirects (>${maxRedirects})`);
}

/* ---------- Скачивание ---------- */

async function download(cfg: UrlSourceOptions, rawUrl: string, workDir: string): Promise<string> {
  const url = await assertSafeUrl(rawUrl, cfg);
  // Уникальный префикс: видео и сабы с одинаковым basename (…/a/index.srt,
  // …/b/index.srt) раньше перезаписывали друг друга в workDir.
  const base = path.basename(decodeURIComponent(url.pathname)).replace(/[^\w.-]+/g, "_");
  const name = `${randomUUID().slice(0, 8)}-${base || "source.bin"}`;

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
