/**
 * stream-precheck и прогрев голов против PGlite и стаба резолвера:
 * rutor и TorrServer не нужны, проверяется логика выбора, записи и тормозов.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { type Db, getStreamSources, migrationsDir, recordStreamSources, reportStreamSource, schema } from "@zal/db";
import type { ResolveQuery, RutorRelease } from "@zal/ingest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRECHECK,
  type MissStore,
  type PrecheckContext,
  type PrecheckResolver,
  type RedisLike,
  redisRateLimiter,
  runHeadWarm,
  runStreamPrecheck,
} from "../src/stream-precheck";

const rel = (hash: string, seeds = 10): RutorRelease => ({
  title: `Матрица 1999 1080p | D ${hash.slice(0, 3)}`,
  hash,
  magnet: `magnet:?xt=urn:btih:${hash}`,
  size: "2 GB",
  sizeBytes: 2 * 1024 ** 3,
  seeds,
  peers: 1,
  quality: "1080p",
  dub: "Дубляж",
  year: 1999,
  category: null,
});
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

class StubResolver implements PrecheckResolver {
  searches: Array<{ q: ResolveQuery; excluded: string[] }> = [];
  checks: string[] = [];
  heads: string[] = [];
  releases: RutorRelease[] = [];
  okHashes = new Set<string>();
  direct = false;
  async hasDirectStream() {
    return this.direct;
  }
  async findTorrentReleases(q: ResolveQuery, excluded: ReadonlySet<string> = new Set()) {
    this.searches.push({ q, excluded: [...excluded] });
    return this.releases.filter((r) => !excluded.has(r.hash));
  }
  async checkRelease(r: RutorRelease) {
    this.checks.push(r.hash);
    return this.okHashes.has(r.hash) ? { hash: r.hash, fileIndex: 3 } : null;
  }
  async warmHead(hash: string) {
    this.heads.push(hash);
    return 1000;
  }
}

function memoryMisses(): MissStore & { set: Set<number> } {
  const set = new Set<number>();
  return {
    set,
    async has(id) {
      return set.has(id);
    },
    async mark(id) {
      set.add(id);
    },
  };
}

let db: Db;
let resolver: StubResolver;
let ctx: PrecheckContext & { misses: ReturnType<typeof memoryMisses> };
let acquired = 0;
let movieId: number;
let movieMedia: number;
const opts = { ...DEFAULT_PRECHECK, pauseMs: 0, breakerEmptyInRow: 2 };

async function addMovie(title: string, views: number) {
  const [it] = await db.insert(schema.items).values({ type: "movie", title, year: 1999, views }).returning();
  const [m] = await db.insert(schema.media).values({ itemId: it!.id, partNumber: 1 }).returning();
  return { itemId: it!.id, mediaId: m!.id };
}

const playable = async (id: number) =>
  (await db.select({ p: schema.items.playable }).from(schema.items).where(eq(schema.items.id, id)))[0]?.p;

// Одна PGlite на файл: экземпляр на тест под параллельным turbo съедал
// память песочницы (SIGKILL). Между тестами — TRUNCATE.
let client: PGlite;
beforeAll(async () => {
  client = new PGlite({ extensions: { pg_trgm } });
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: migrationsDir });
  db = d as unknown as Db;
});
afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate items, media, stream_sources restart identity cascade`);
  resolver = new StubResolver();
  acquired = 0;
  ctx = {
    db,
    resolver,
    limiter: {
      async acquire() {
        acquired++;
      },
    },
    misses: memoryMisses(),
    sleep: async () => {},
  };
  ({ itemId: movieId, mediaId: movieMedia } = await addMovie("Матрица", 100));
});

describe("runStreamPrecheck", () => {
  it("поиск → запись → проверка: good с индексом файла, playable", async () => {
    resolver.releases = [rel(H1, 50), rel(H2, 5)];
    resolver.okHashes.add(H1);
    const s = await runStreamPrecheck(ctx, opts);
    expect(s.outcomes.ok).toBe(1);
    expect(acquired).toBe(1);
    const rows = await getStreamSources(db, movieMedia);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ infohash: H1, status: "good", fileIndex: 3 });
    expect(rows[0]?.voices).toEqual(["Дубляж"]);
    expect(rows[1]?.checkedAt).toBeNull();
    expect(await playable(movieId)).toBe(true);

    // Повторный прогон: пара свежая — ни поиска, ни проверки.
    resolver.searches.length = 0;
    resolver.checks.length = 0;
    const again = await runStreamPrecheck(ctx, opts);
    expect(again.targets).toBe(0);
    expect(resolver.searches).toHaveLength(0);
  });

  it("лучший релиз не прошёл — проверяется следующий, неудача копится", async () => {
    resolver.releases = [rel(H1, 50), rel(H2, 5)];
    resolver.okHashes.add(H2);
    await runStreamPrecheck(ctx, opts);
    expect(resolver.checks).toEqual([H1, H2]);
    const rows = await getStreamSources(db, movieMedia);
    const byHash = Object.fromEntries(rows.map((r) => [r.infohash, r]));
    expect(byHash[H1]).toMatchObject({ failCount: 1, status: "good" });
    expect(byHash[H2]).toMatchObject({ fileIndex: 3, failCount: 0 });
  });

  it("пожалованный хеш уходит в поиск исключением и не проверяется", async () => {
    await reportStreamSource(db, { itemId: movieId, mediaId: movieMedia }, H1);
    resolver.releases = [rel(H1, 50), rel(H2, 5)];
    resolver.okHashes.add(H1).add(H2);
    await runStreamPrecheck(ctx, opts);
    expect(resolver.searches[0]?.excluded).toEqual([H1]);
    expect(resolver.checks).toEqual([H2]);
  });

  it("пустая выдача: промах запоминается, playable не трогаем, пока rutor не подтвердил, что жив", async () => {
    const s = await runStreamPrecheck(ctx, opts);
    expect(s.outcomes.empty).toBe(1);
    expect(ctx.misses.set.has(movieMedia)).toBe(true);
    expect(await playable(movieId)).toBeNull();
    // Запомненный промах не идёт в цели следующего прогона.
    const again = await runStreamPrecheck(ctx, opts);
    expect(again.targets).toBe(0);
  });

  it("предохранитель: серия пустых выдач останавливает батч", async () => {
    await addMovie("Второй", 50);
    await addMovie("Третий", 10);
    const s = await runStreamPrecheck(ctx, opts);
    expect(s.tripped).toBe(true);
    expect(resolver.searches).toHaveLength(2);
  });

  it("аниме с готовым HLS — playable без rutor", async () => {
    await db.update(schema.items).set({ type: "anime" }).where(eq(schema.items.id, movieId));
    resolver.direct = true;
    const s = await runStreamPrecheck(ctx, opts);
    expect(s.outcomes.direct).toBe(1);
    expect(resolver.searches).toHaveLength(0);
    expect(await playable(movieId)).toBe(true);
  });

  it("перепроверка устаревших: непроверенная запись проверяется без нового поиска", async () => {
    // Два кандидата в таблице (как после клика) — поиск не нужен.
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [
      { infohash: H1, magnet: `magnet:?xt=urn:btih:${H1}`, title: "a", seeds: 9 },
      { infohash: H2, magnet: `magnet:?xt=urn:btih:${H2}`, title: "b", seeds: 1 },
    ]);
    resolver.okHashes.add(H1);
    await runStreamPrecheck(ctx, opts);
    expect(resolver.searches).toHaveLength(0);
    expect(resolver.checks).toEqual([H1]);
  });
});

describe("runHeadWarm", () => {
  it("греет проверенные раздачи и останавливается у потолка диска", async () => {
    const second = await addMovie("Второй", 50);
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [
      { infohash: H1, magnet: "m1", title: "a", fileIndex: 1 },
    ]);
    await recordStreamSources(db, second, [{ infohash: H2, magnet: "m2", title: "b", fileIndex: 2 }]);
    const touched: string[] = [];
    const base = {
      top: 10,
      headBytes: 1000,
      cacheDir: "/cache",
      maxBytes: 10_000,
      fillRatio: 0.9,
      pauseMs: 0,
    };
    const ok = await runHeadWarm(
      { ...ctx, diskUsage: async () => 0, touch: async (p) => void touched.push(p) },
      base,
    );
    expect(ok).toEqual({ targets: 2, warmed: 2, diskFull: false });
    // Популярное — первым; каталог раздачи «тронут» для LRU ts-cache-prune.
    expect(resolver.heads).toEqual([H1, H2]);
    expect(touched).toEqual([`/cache/${H1}`, `/cache/${H2}`]);

    resolver.heads.length = 0;
    const full = await runHeadWarm({ ...ctx, diskUsage: async () => 8_500, touch: async () => {} }, base);
    expect(full.diskFull).toBe(true);
    expect(resolver.heads).toEqual([]);
  });
});

describe("redisRateLimiter", () => {
  it("сверх лимита ждёт следующую минуту", async () => {
    const store = new Map<string, number>();
    const redis: RedisLike = {
      async incr(k) {
        const n = (store.get(k) ?? 0) + 1;
        store.set(k, n);
        return n;
      },
      async expire() {
        return 1;
      },
      async exists() {
        return 0;
      },
      async set() {
        return "OK";
      },
    };
    let clock = 60_000 * 1000 + 10;
    const sleeps: number[] = [];
    const limiter = redisRateLimiter(
      redis,
      "rl:test",
      2,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      () => clock,
    );
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([]);
    await limiter.acquire();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);
  });
});
