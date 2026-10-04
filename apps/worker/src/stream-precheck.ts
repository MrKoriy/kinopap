/**
 * stream-precheck и прогрев голов: «Смотреть» без живого скрейпа.
 *
 * - stream-precheck (каждые 15 мин, батч): для следующей серии у тех, кто
 *   смотрит сериал, подписок/избранного, свежих лент и топ-1000 популярных
 *   находит раздачи на rutor, проверяет лучшую в TorrServer (метаданные +
 *   файл нужной серии) и пишет в stream_sources. Плюс перепроверка
 *   устаревших good-записей. Клик потом берёт good-запись и в rutor не ходит.
 * - stream-headwarm (каждые 30 мин): голова файла (STREAM_HEAD_MB) у топ-N
 *   проверенных раздач читается через TorrServer в его дисковый кэш. Объём
 *   держит существующий kinopap-ts-prune.timer (bin/ts-cache-prune.py,
 *   LRU по mtime, TS_CACHE_MAX_GB) — здесь мы лишь не лезем выше потолка и
 *   «трогаем» каталог раздачи, чтобы горячий набор был свежим для LRU.
 *
 * Бережём rutor: строго по одной паре, пауза между парами, общий лимит
 * поисков в минуту через Redis (переживает рестарт, общий для инстансов),
 * и предохранитель — серия пустых выдач подряд останавливает батч (rutor
 * лежит или режет нас), не размножая ложные «нет источника».
 */
import { readdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  bannedStreamHashes,
  type Db,
  getStreamSources,
  headWarmTargets,
  markStreamSourceChecked,
  prewarmCandidates,
  recordStreamSources,
  refreshItemPlayable,
  type StreamResolveTarget,
  shortcutItems,
  staleStreamPairs,
  streamResolveTarget,
} from "@zal/db";
import {
  knownToRelease,
  type ReleaseCheck,
  type ResolveQuery,
  type RutorRelease,
  toStreamCandidate,
} from "@zal/ingest";

const HOUR = 60 * 60 * 1000;

/** Кусок StreamResolver, нужный фоновым задачам (в тестах — стаб). */
export interface PrecheckResolver {
  hasDirectStream(query: ResolveQuery): Promise<boolean>;
  findTorrentReleases(query: ResolveQuery, excluded?: ReadonlySet<string>): Promise<RutorRelease[]>;
  checkRelease(
    rel: RutorRelease,
    query: ResolveQuery,
    opts?: { metadataWaitMs?: number },
  ): Promise<ReleaseCheck | null>;
  warmHead(hash: string, fileIndex: number, bytes: number): Promise<number>;
}

/** Общий лимит поисков на rutor (token-bucket-подобное окно в Redis). */
export interface RateLimiter {
  acquire(): Promise<void>;
}

/** Память «искали — ничего нет» по media: не долбим rutor тем же запросом. */
export interface MissStore {
  has(mediaId: number): Promise<boolean>;
  mark(mediaId: number, ttlSec: number): Promise<void>;
}

export interface PrecheckContext {
  db: Db;
  resolver: PrecheckResolver;
  limiter: RateLimiter;
  misses: MissStore;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface PrecheckOptions {
  /** Сколько пар проверять за прогон. */
  batch: number;
  /** Топ популярных, из которого берутся цели. */
  topLimit: number;
  /** Сколько устаревших good-записей перепроверить за прогон. */
  recheckBatch: number;
  /** Проверка старше — пора перепроверить. */
  recheckAfterMs: number;
  /** Пауза между парами. */
  pauseMs: number;
  /** Сколько релизов пары проверять в TorrServer, пока не найдётся рабочий. */
  checksPerPair: number;
  /** Ожидание метаданных торрента при проверке. */
  metadataWaitMs: number;
  /** Пустых поисков подряд — и батч останавливается (rutor лежит). */
  breakerEmptyInRow: number;
  /** На сколько запомнить «ничего не нашли». */
  missTtlSec: number;
}

export const DEFAULT_PRECHECK: PrecheckOptions = {
  batch: 80,
  topLimit: 1000,
  recheckBatch: 20,
  recheckAfterMs: 72 * HOUR,
  pauseMs: 2000,
  checksPerPair: 2,
  metadataWaitMs: 8000,
  breakerEmptyInRow: 8,
  missTtlSec: 24 * 60 * 60,
};

export type PairOutcome = "direct" | "ok" | "fail" | "empty" | "skip";

/** Цель резолвера из контекста пары (те же правила, что у клика). */
function toQuery(t: StreamResolveTarget): ResolveQuery {
  return {
    itemId: t.itemId,
    mediaId: t.mediaId,
    title: t.title,
    originalTitle: t.originalTitle,
    year: t.year,
    type: t.type,
    seasonNumber: t.seasonNumber ?? undefined,
    episodeNumber: t.episodeNumber ?? undefined,
    absoluteNumber: t.absoluteNumber,
    externalSource: t.externalSource,
    externalId: t.externalId,
  };
}

/**
 * Одна пара (item, media): готовый HLS → сразу playable; иначе — уже
 * известные непроверенные/устаревшие раздачи, при нехватке — поиск rutor
 * (через лимитер), затем проверка до `checksPerPair` релизов по очереди.
 * `rutorAlive` — был ли в этом прогоне хоть один непустой поиск: только
 * тогда пустая выдача честно значит «нет раздач» (playable=false).
 */
export async function precheckPair(
  ctx: PrecheckContext,
  pair: { itemId: number; mediaId: number },
  opts: PrecheckOptions,
  state: { rutorAlive: boolean },
): Promise<PairOutcome> {
  const target = await streamResolveTarget(ctx.db, pair.itemId, pair.mediaId);
  if (!target) return "skip";
  const query = toQuery(target);

  if (target.externalSource === "anilibria" || target.type === "anime") {
    if (await ctx.resolver.hasDirectStream(query).catch(() => false)) {
      await refreshItemPlayable(ctx.db, target.itemId, { checked: true, hasDirect: true });
      return "direct";
    }
  }

  const rows = await getStreamSources(ctx.db, pair.mediaId);
  const banned = new Set(bannedStreamHashes(rows));
  const freshCutoff = Date.now() - opts.recheckAfterMs;
  // Кандидаты из таблицы: живые (не bad/dead), ещё не проверенные или устаревшие.
  let pool: RutorRelease[] = rows
    .filter(
      (r) =>
        r.status === "good" &&
        (r.checkedAt == null || r.checkedAt.getTime() < freshCutoff || r.fileIndex == null),
    )
    .map((r) =>
      knownToRelease({
        hash: r.infohash,
        magnet: r.magnet,
        title: r.title,
        quality: r.quality,
        sizeBytes: r.sizeBytes,
        seeds: r.seeds,
        peers: r.peers,
      }),
    );

  if (pool.length < opts.checksPerPair) {
    await ctx.limiter.acquire();
    const found = await ctx.resolver.findTorrentReleases(query, banned).catch(() => []);
    if (found.length > 0) {
      state.rutorAlive = true;
      await recordStreamSources(
        ctx.db,
        { itemId: target.itemId, mediaId: target.mediaId, episodeId: target.episodeId },
        found.map((rel) => {
          const c = toStreamCandidate(rel);
          return { ...c, infohash: c.hash };
        }),
      );
      const inPool = new Set(pool.map((p) => p.hash));
      pool = [...pool, ...found.filter((f) => !inPool.has(f.hash))];
    } else if (pool.length === 0) {
      await ctx.misses.mark(pair.mediaId, opts.missTtlSec);
      if (target.isEntryMedia && state.rutorAlive) {
        await refreshItemPlayable(ctx.db, target.itemId, { checked: true });
      }
      return "empty";
    }
  }

  // Сначала живые по сидам: мёртвый релиз проверять дороже всего.
  pool.sort((a, b) => b.seeds - a.seeds);
  for (const rel of pool.slice(0, opts.checksPerPair)) {
    const check = await ctx.resolver
      .checkRelease(rel, query, { metadataWaitMs: opts.metadataWaitMs })
      .catch(() => null);
    await markStreamSourceChecked(
      ctx.db,
      pair.mediaId,
      rel.hash,
      check ? { ok: true, fileIndex: check.fileIndex } : { ok: false },
    );
    if (check) {
      await refreshItemPlayable(ctx.db, target.itemId, { checked: true });
      return "ok";
    }
  }
  if (target.isEntryMedia) await refreshItemPlayable(ctx.db, target.itemId, { checked: true });
  return "fail";
}

export interface PrecheckSummary {
  targets: number;
  outcomes: Record<PairOutcome, number>;
  /** Сработал предохранитель: rutor подряд отдавал пусто. */
  tripped: boolean;
}

/** Цели прогона: новые/непроверенные пары + перепроверка устаревших. */
export async function precheckTargets(
  ctx: PrecheckContext,
  opts: PrecheckOptions,
): Promise<Array<{ itemId: number; mediaId: number }>> {
  // «Свежее» и «горячее» с главной — в общий пул вместе с подписками/топом.
  const rails = await Promise.all(
    (["fresh", "hot"] as const).map((k) =>
      shortcutItems(ctx.db, k, { limit: 48 }).catch(() => ({ items: [] as Array<{ id: number }> })),
    ),
  );
  const extraItemIds = rails.flatMap((p) => p.items.map((i) => i.id));
  const fresh = await prewarmCandidates(ctx.db, {
    // С запасом: часть отсеется памятью промахов.
    limit: opts.batch * 2,
    topLimit: opts.topLimit,
    extraItemIds,
    freshMs: opts.recheckAfterMs,
    freshness: "stream_sources",
  });
  const stale = await staleStreamPairs(ctx.db, {
    olderThanMs: opts.recheckAfterMs,
    limit: opts.recheckBatch,
  });
  const seen = new Set<number>();
  const out: Array<{ itemId: number; mediaId: number }> = [];
  for (const t of fresh) {
    if (t.mediaId == null || seen.has(t.mediaId)) continue;
    if (out.length >= opts.batch) break;
    if (await ctx.misses.has(t.mediaId)) continue;
    seen.add(t.mediaId);
    out.push({ itemId: t.itemId, mediaId: t.mediaId });
  }
  for (const t of stale) {
    if (seen.has(t.mediaId)) continue;
    seen.add(t.mediaId);
    out.push(t);
  }
  return out;
}

/** Один прогон stream-precheck. */
export async function runStreamPrecheck(
  ctx: PrecheckContext,
  opts: PrecheckOptions = DEFAULT_PRECHECK,
): Promise<PrecheckSummary> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const targets = await precheckTargets(ctx, opts);
  const outcomes: Record<PairOutcome, number> = { direct: 0, ok: 0, fail: 0, empty: 0, skip: 0 };
  const state = { rutorAlive: false };
  let emptyInRow = 0;
  let tripped = false;
  for (const [i, t] of targets.entries()) {
    let outcome: PairOutcome;
    try {
      outcome = await precheckPair(ctx, t, opts, state);
    } catch (err) {
      ctx.log?.(`stream-precheck: item=${t.itemId} media=${t.mediaId} failed: ${String(err).slice(0, 160)}`);
      outcome = "skip";
    }
    outcomes[outcome]++;
    emptyInRow = outcome === "empty" ? emptyInRow + 1 : 0;
    if (emptyInRow >= opts.breakerEmptyInRow) {
      tripped = true;
      ctx.log?.(`stream-precheck: ${emptyInRow} пустых выдач подряд — rutor не отвечает, батч остановлен`);
      break;
    }
    if (i < targets.length - 1) await sleep(opts.pauseMs);
  }
  return { targets: targets.length, outcomes, tripped };
}

/* ---------- Прогрев голов файлов ---------- */

export interface HeadWarmOptions {
  /** Сколько раздач держать горячими. */
  top: number;
  /** Сколько байт головы файла читать. */
  headBytes: number;
  /** Каталог дискового кэша TorrServer (TS_CACHE_DIR). */
  cacheDir: string;
  /** Потолок кэша (TS_CACHE_MAX_GB) в байтах. */
  maxBytes: number;
  /** Доля потолка, после которой новые головы не тянем (LRU-обрезка — у ts-prune). */
  fillRatio: number;
  pauseMs: number;
}

export interface HeadWarmSummary {
  targets: number;
  warmed: number;
  /** Остановились у потолка диска. */
  diskFull: boolean;
}

/** Размер каталога (рекурсивно); нет каталога — 0. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      try {
        total += (await stat(p)).size;
      } catch {
        // файл ушёл под обрезкой — пропускаем
      }
    }
  }
  return total;
}

/**
 * Один прогон прогрева: голова файла у топ-N проверенных раздач. Перед
 * каждой следующей — сверка с потолком диска; дошли до `fillRatio` —
 * стоп (вытеснение по LRU делает ts-cache-prune). Каталог раздачи
 * «трогаем» (mtime), чтобы прогретое не ушло первым под обрезку.
 */
export async function runHeadWarm(
  ctx: Pick<PrecheckContext, "db" | "resolver" | "sleep" | "log"> & {
    diskUsage?: (dir: string) => Promise<number>;
    touch?: (path: string) => Promise<void>;
  },
  opts: HeadWarmOptions,
): Promise<HeadWarmSummary> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const usage = ctx.diskUsage ?? dirSize;
  const touch =
    ctx.touch ??
    (async (p: string) => {
      const now = new Date();
      await utimes(p, now, now).catch(() => {});
    });
  const targets = await headWarmTargets(ctx.db, opts.top);
  const ceiling = opts.maxBytes * opts.fillRatio;
  let used = await usage(opts.cacheDir);
  let warmed = 0;
  let diskFull = false;
  for (const t of targets) {
    if (used + opts.headBytes > ceiling) {
      diskFull = true;
      break;
    }
    const read = await ctx.resolver.warmHead(t.infohash, t.fileIndex, opts.headBytes).catch(() => 0);
    await touch(join(opts.cacheDir, t.infohash));
    if (read > 0) {
      warmed++;
      used += read;
    }
    await sleep(opts.pauseMs);
  }
  return { targets: targets.length, warmed, diskFull };
}

/* ---------- Redis-примитивы ---------- */

/** Минимум ioredis, который нужен лимитеру и памяти промахов. */
export interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  exists(key: string): Promise<number>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

/**
 * Окно «не больше N в минуту» в Redis: общий счётчик минуты; переполнили —
 * ждём начала следующей. Redis недоступен — не блокируемся (пауза между
 * парами всё равно держит темп).
 */
export function redisRateLimiter(
  redis: RedisLike,
  key: string,
  perMinute: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): RateLimiter {
  return {
    async acquire() {
      for (let attempt = 0; attempt < 10; attempt++) {
        const minute = Math.floor(now() / 60_000);
        const k = `${key}:${minute}`;
        let n: number;
        try {
          n = await redis.incr(k);
          if (n === 1) await redis.expire(k, 120);
        } catch {
          return;
        }
        if (n <= perMinute) return;
        await sleep((minute + 1) * 60_000 - now() + 50);
      }
    },
  };
}

export function redisMissStore(redis: RedisLike, prefix = "stream-precheck:miss"): MissStore {
  return {
    async has(mediaId) {
      try {
        return (await redis.exists(`${prefix}:${mediaId}`)) > 0;
      } catch {
        return false;
      }
    },
    async mark(mediaId, ttlSec) {
      await redis.set(`${prefix}:${mediaId}`, "1", "EX", ttlSec).catch(() => {});
    },
  };
}
