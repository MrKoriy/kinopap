/**
 * Старт видео: проверенные раздачи из stream_sources, жалоба «не играет /
 * не та серия» и префетч с карточки.
 */
import { mediaLinksSchema } from "@zal/api-client";
import { getSource, getStreamSources, markStreamSourceChecked, recordStreamSources, saveSource } from "@zal/db";
import { describe, expect, it } from "vitest";
import { makeFixtures } from "./fixtures";
import { createTestApp } from "./setup";

const H1 = "c".repeat(40);
const H2 = "d".repeat(40);
const source = (hash: string, fileIndex: number | null, seeds = 10) => ({
  infohash: hash,
  magnet: `magnet:?xt=urn:btih:${hash}&dn=x`,
  title: `Сериал S01E01 1080p ${hash.slice(0, 3)}`,
  quality: "1080p",
  sizeBytes: 1_500_000_000,
  voices: ["LostFilm"],
  seeds,
  peers: 1,
  fileIndex,
});

describe("media-links из stream_sources", () => {
  it("проверенная раздача отдаётся без поиска, с точным индексом файла", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    await recordStreamSources(db, { itemId: ids.serial, mediaId: ids.episodeMedia }, [source(H1, 4)]);
    const res = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/media-links?mid=${ids.episodeMedia}`,
    });
    expect(res.statusCode).toBe(200);
    const links = mediaLinksSchema.parse(res.json());
    expect(links.files).toHaveLength(1);
    expect(links.files[0]?.urls.hls).toContain(`/gst/${H1}/master.m3u8?index=4`);
  });

  it("забаненная раздача не выдаётся, берётся следующая", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    await recordStreamSources(db, { itemId: ids.serial, mediaId: ids.episodeMedia }, [
      source(H1, 4, 100),
      source(H2, 2, 5),
    ]);
    const rep = await app.inject({
      method: "POST",
      url: `/v1/media/${ids.episodeMedia}/report`,
      payload: { reason: "wrong_episode", url: `/gst/${H1}/master.m3u8?index=4&audio=0` },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toEqual({ ok: true, banned: true });
    const res = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/media-links?mid=${ids.episodeMedia}`,
    });
    const links = mediaLinksSchema.parse(res.json());
    expect(links.files.map((f) => f.urls.hls)).toEqual([
      expect.stringContaining(`/gst/${H2}/master.m3u8?index=2`),
    ]);
  });
});

describe("POST /v1/media/:id/report", () => {
  it("гость: раздача → bad, снимок резолва пары сброшен", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    await recordStreamSources(db, { itemId: ids.serial, mediaId: ids.episodeMedia }, [source(H1, 1)]);
    await saveSource(db, {
      itemId: ids.serial,
      mediaId: ids.episodeMedia,
      files: [],
      audios: [],
      intro: null,
      warm: null,
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${ids.episodeMedia}/report`,
      payload: { reason: "not_playing", hash: H1.toUpperCase() },
    });
    expect(res.statusCode).toBe(200);
    const rows = await getStreamSources(db, ids.episodeMedia);
    expect(rows[0]).toMatchObject({ infohash: H1, status: "bad", reportCount: 1 });
    expect(await getSource(db, ids.serial, ids.episodeMedia)).toBeNull();
    // Повторная проверка воркера bad не перетирает.
    await markStreamSourceChecked(db, ids.episodeMedia, H1, { ok: true, fileIndex: 1 });
    expect((await getStreamSources(db, ids.episodeMedia))[0]?.status).toBe("bad");
  });

  it("не торрент (нет хеша) — ok, но без бана", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${ids.movieMedia}/report`,
      payload: { reason: "other", url: "https://cdn.test/m/1/master.m3u8" },
    });
    expect(res.json()).toEqual({ ok: true, banned: false });
  });

  it("неизвестный media — 404, мусорная причина — 400", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/media/999999/report",
      payload: { reason: "not_playing", hash: H1 },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: "POST",
      url: `/v1/media/${ids.movieMedia}/report`,
      payload: { reason: "boom" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("rate limit: 11-я жалоба за минуту — 429", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/v1/media/${ids.movieMedia}/report`,
        payload: { reason: "other" },
      });
      expect(r.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: `/v1/media/${ids.movieMedia}/report`,
      payload: { reason: "other" },
    });
    expect(limited.statusCode).toBe(429);
  });
});

describe("POST /v1/items/:id/prefetch", () => {
  it("проверенная раздача — ready, без фонового резолва", async () => {
    const { app, db } = await createTestApp({ env: { PREFETCH_CONCURRENCY: "0" } });
    const ids = await makeFixtures(db);
    await recordStreamSources(db, { itemId: ids.serial, mediaId: ids.episodeMedia }, [source(H1, 1)]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/items/${ids.serial}/prefetch`,
      payload: { mid: ids.episodeMedia },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ready: true, queued: false });
  });

  it("нет источника и потолок параллельности исчерпан — не ставит резолв", async () => {
    const { app, db } = await createTestApp({ env: { PREFETCH_CONCURRENCY: "0" } });
    const ids = await makeFixtures(db);
    // Без mid берётся первая серия тайтла.
    const res = await app.inject({ method: "POST", url: `/v1/items/${ids.serial}/prefetch`, payload: {} });
    expect(res.json()).toEqual({ ready: false, queued: false });
  });

  it("тайтл без media — пустой ответ, не 500", async () => {
    const { app } = await createTestApp({ env: { PREFETCH_CONCURRENCY: "0" } });
    const res = await app.inject({ method: "POST", url: "/v1/items/424242/prefetch", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ready: false, queued: false });
  });
});
