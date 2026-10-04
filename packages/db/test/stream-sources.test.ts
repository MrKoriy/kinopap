/**
 * stream_sources: заранее найденные раздачи, жалобы и флаг playable.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import {
  bannedStreamHashes,
  getStreamSources,
  headWarmTargets,
  markStreamSourceChecked,
  mediaWithFreshSources,
  recordStreamSources,
  refreshItemPlayable,
  reportStreamSource,
  STREAM_DEAD_AFTER_FAILS,
  staleStreamPairs,
  streamResolveTarget,
  usableStreamSources,
} from "../src/repos/stream-sources";
import * as schema from "../src/schema/index";
import { createTestDb } from "./helpers";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const cand = (hash: string, extra: Record<string, unknown> = {}) => ({
  infohash: hash,
  magnet: `magnet:?xt=urn:btih:${hash}`,
  title: `Release ${hash.slice(0, 4)} 1080p`,
  quality: "1080p",
  sizeBytes: 2_000_000_000,
  voices: ["Дубляж"],
  seeds: 10,
  peers: 2,
  ...extra,
});

let db: Db;
let movieId: number;
let movieMedia: number;
let serialId: number;
let ep2Media: number;

beforeEach(async () => {
  db = (await createTestDb()) as unknown as Db;
  const [movie] = await db
    .insert(schema.items)
    .values({ type: "movie", title: "Матрица", originalTitle: "The Matrix", year: 1999, views: 5 })
    .returning();
  movieId = movie!.id;
  const [mm] = await db.insert(schema.media).values({ itemId: movieId, partNumber: 1 }).returning();
  movieMedia = mm!.id;

  const [serial] = await db
    .insert(schema.items)
    .values({ type: "serial", title: "Игра престолов", year: 2011, views: 50 })
    .returning();
  serialId = serial!.id;
  const [season] = await db
    .insert(schema.seasons)
    .values({ itemId: serialId, number: 1, title: "Сезон 1" })
    .returning();
  const [ep2] = await db
    .insert(schema.episodes)
    .values({ seasonId: season!.id, number: 2, title: "Королевский тракт", origNumber: 7, origSeason: 2 })
    .returning();
  const [em] = await db
    .insert(schema.media)
    .values({ itemId: serialId, episodeId: ep2!.id, partNumber: 1 })
    .returning();
  ep2Media = em!.id;
});

describe("streamResolveTarget", () => {
  it("фильм: без S/E, entry media", async () => {
    const t = await streamResolveTarget(db, movieId, movieMedia);
    expect(t).toMatchObject({
      title: "Матрица",
      originalTitle: "The Matrix",
      year: 1999,
      type: "movie",
      seasonNumber: null,
      episodeNumber: null,
      isEntryMedia: true,
    });
  });

  it("серия: координаты источника (orig_season/orig_number), не первая серия", async () => {
    const t = await streamResolveTarget(db, serialId, ep2Media);
    expect(t).toMatchObject({ seasonNumber: 2, episodeNumber: 7, isEntryMedia: false });
    expect(t?.episodeId).not.toBeNull();
  });

  it("чужая пара (item, media) — null", async () => {
    expect(await streamResolveTarget(db, movieId, ep2Media)).toBeNull();
  });
});

describe("recordStreamSources / usable", () => {
  it("непроверенные кандидаты не годятся для клика, проверенные — да", async () => {
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [cand(H1), cand(H2)]);
    let rows = await getStreamSources(db, movieMedia);
    expect(rows).toHaveLength(2);
    expect(usableStreamSources(rows, 86_400_000)).toHaveLength(0);

    await markStreamSourceChecked(db, movieMedia, H2, { ok: true, fileIndex: 3 });
    rows = await getStreamSources(db, movieMedia);
    const usable = usableStreamSources(rows, 86_400_000);
    expect(usable.map((r) => r.infohash)).toEqual([H2]);
    expect(usable[0]?.fileIndex).toBe(3);
    // Проверенный — первым в общем списке.
    expect(rows[0]?.infohash).toBe(H2);
  });

  it("протухшая проверка не годится", async () => {
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [cand(H1, { fileIndex: 2 })]);
    const rows = await getStreamSources(db, movieMedia);
    expect(usableStreamSources(rows, 1000, Date.now() + 5000)).toHaveLength(0);
  });

  it("повторная находка обновляет сиды, но не воскрешает bad", async () => {
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [cand(H1, { fileIndex: 1 })]);
    await reportStreamSource(db, { itemId: movieId, mediaId: movieMedia }, H1);
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [
      cand(H1, { seeds: 99, fileIndex: 1 }),
    ]);
    const [row] = await getStreamSources(db, movieMedia);
    expect(row?.seeds).toBe(99);
    expect(row?.status).toBe("bad");
    expect(bannedStreamHashes([row!])).toEqual([H1]);
  });
});

describe("проверки и жалобы", () => {
  it(`${STREAM_DEAD_AFTER_FAILS} провала подряд → dead, успех возвращает good`, async () => {
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [cand(H1)]);
    for (let i = 0; i < STREAM_DEAD_AFTER_FAILS - 1; i++) {
      await markStreamSourceChecked(db, movieMedia, H1, { ok: false });
    }
    let [row] = await getStreamSources(db, movieMedia);
    expect(row?.status).toBe("good");
    await markStreamSourceChecked(db, movieMedia, H1, { ok: false });
    [row] = await getStreamSources(db, movieMedia);
    expect(row?.status).toBe("dead");
    expect(row?.failCount).toBe(STREAM_DEAD_AFTER_FAILS);
    await markStreamSourceChecked(db, movieMedia, H1, { ok: true, fileIndex: 4 });
    [row] = await getStreamSources(db, movieMedia);
    expect(row).toMatchObject({ status: "good", failCount: 0, fileIndex: 4 });
  });

  it("жалоба на неизвестный хеш заводит bad-строку; повтор — счётчик", async () => {
    const r1 = await reportStreamSource(db, { itemId: movieId, mediaId: movieMedia }, H1.toUpperCase());
    const r2 = await reportStreamSource(db, { itemId: movieId, mediaId: movieMedia }, H1);
    expect(r1.reportCount).toBe(1);
    expect(r2.reportCount).toBe(2);
    const rows = await getStreamSources(db, movieMedia);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ infohash: H1, status: "bad" });
  });

  it("жалоба бьёт только по своей серии", async () => {
    await recordStreamSources(db, { itemId: serialId, mediaId: ep2Media }, [cand(H1, { fileIndex: 1 })]);
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [cand(H1, { fileIndex: 1 })]);
    await reportStreamSource(db, { itemId: serialId, mediaId: ep2Media }, H1);
    expect((await getStreamSources(db, movieMedia))[0]?.status).toBe("good");
  });
});

describe("playable", () => {
  const playable = async (id: number) =>
    (await db.select({ p: schema.items.playable }).from(schema.items).where(eq(schema.items.id, id)))[0]?.p;

  it("null → false после пустой проверки → true при good-раздаче", async () => {
    expect(await playable(movieId)).toBeNull();
    await refreshItemPlayable(db, movieId, { checked: false });
    expect(await playable(movieId)).toBeNull();
    await refreshItemPlayable(db, movieId, { checked: true });
    expect(await playable(movieId)).toBe(false);
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [cand(H1, { fileIndex: 1 })]);
    await refreshItemPlayable(db, movieId, { checked: true });
    expect(await playable(movieId)).toBe(true);
  });

  it("готовый HLS (AniLibria) — playable без раздач", async () => {
    await refreshItemPlayable(db, serialId, { checked: true, hasDirect: true });
    expect(await playable(serialId)).toBe(true);
  });
});

describe("цели прогрева и перепроверки", () => {
  it("headWarmTargets: только проверенные good, популярное первым, по одной на media", async () => {
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [
      cand(H1, { fileIndex: 1, seeds: 5 }),
      cand(H2, { fileIndex: 2, seeds: 50 }),
    ]);
    await recordStreamSources(db, { itemId: serialId, mediaId: ep2Media }, [cand(H1, { fileIndex: 7 })]);
    await recordStreamSources(db, { itemId: serialId, mediaId: ep2Media }, [cand(H2)]);
    const targets = await headWarmTargets(db, 10);
    expect(targets.map((t) => t.mediaId)).toEqual([ep2Media, movieMedia]);
    expect(targets[1]).toMatchObject({ infohash: H2, fileIndex: 2 });
    expect(await headWarmTargets(db, 1)).toHaveLength(1);
  });

  it("staleStreamPairs и mediaWithFreshSources", async () => {
    await recordStreamSources(db, { itemId: movieId, mediaId: movieMedia }, [cand(H1, { fileIndex: 1 })]);
    await recordStreamSources(db, { itemId: serialId, mediaId: ep2Media }, [cand(H2)]);
    // Серия не проверялась вовсе — сразу в перепроверку; фильм свеж.
    expect(await staleStreamPairs(db, { olderThanMs: 3_600_000, limit: 10 })).toEqual([
      { itemId: serialId, mediaId: ep2Media },
    ]);
    const fresh = await mediaWithFreshSources(db, [movieMedia, ep2Media], 3_600_000);
    expect([...fresh]).toEqual([movieMedia]);
  });
});
