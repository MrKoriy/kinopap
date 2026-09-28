/**
 * Кэш резолва (media_sources) и ленивые аудио-дорожки.
 *
 * Главное, что здесь проверяется: warm и дорожки переживают рестарт API —
 * они лежат в БД, а не в памяти процесса. Деплой больше не обнуляет прогрев.
 */
import type { AudioTrack, MediaFile, WarmRelease } from "@zal/api-client";
import { mediaLinksSchema, mediaTracksSchema } from "@zal/api-client";
import { getSource, saveSource } from "@zal/db";
import { describe, expect, it } from "vitest";
import { makeFixtures } from "./fixtures";
import { createTestApp } from "./setup";

const FILE: MediaFile = {
  quality: "1080p WEB-DL [2.5 GB, 120 seeds]",
  qualityId: 1080,
  width: 1920,
  height: 1080,
  codec: "h264",
  bitrate: null,
  sizeBytes: 2_500_000_000,
  urls: {
    http: "http://torr.test/stream?link=abc&index=3&play",
    hls: "http://torr.test/gst/abc/master.m3u8?index=3&audio=0",
  },
};

const WARM: WarmRelease = {
  hash: "a".repeat(40),
  fileIndex: 3,
  magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
  title: "Гадкий я 2010 1080p",
};

const AUDIO: AudioTrack = {
  id: 1,
  index: 1,
  codec: "aac",
  channels: 2,
  lang: "rus",
  type: "dub",
  author: { title: "Дубляж", shortTitle: "Дубляж" },
  url: null,
  masterUrl: "http://torr.test/gst/abc/master.m3u8?index=3&audio=1",
};

describe("resolve cache (media_sources)", () => {
  it("media-links читает свежий кэш из БД без похода в rutor", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    // Пишем в БД напрямую: L1 в памяти процесса пуст, как после рестарта.
    await saveSource(db, {
      itemId: ids.serial,
      mediaId: ids.episodeMedia,
      files: [FILE],
      audios: [],
      intro: null,
      warm: WARM,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/media-links?mid=${ids.episodeMedia}`,
    });

    expect(res.statusCode).toBe(200);
    const links = mediaLinksSchema.parse(res.json());
    expect(links.files).toHaveLength(1);
    expect(links.files[0]!.urls.hls).toContain("index=3");
    // warm в публичный DTO не попадает — магниты клиенту не положены.
    expect("warm" in res.json()).toBe(false);
  });

  it("saveSource перезаписывает запись, getSource отдаёт свежий warm", async () => {
    const { db } = await createTestApp();
    const ids = await makeFixtures(db);

    await saveSource(db, {
      itemId: ids.movie,
      mediaId: ids.movieMedia,
      files: [FILE],
      audios: [],
      intro: null,
      warm: WARM,
    });
    const updated: WarmRelease = { ...WARM, fileIndex: 7 };
    await saveSource(db, {
      itemId: ids.movie,
      mediaId: ids.movieMedia,
      files: [FILE],
      audios: [],
      intro: null,
      warm: updated,
    });

    const row = await getSource(db, ids.movie, ids.movieMedia);
    expect(row?.warm?.fileIndex).toBe(7);
  });
});

describe("GET /items/:id/media-tracks", () => {
  it("отдаёт кэшированные дорожки из БД, ничего не пробуя", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    await saveSource(db, {
      itemId: ids.serial,
      mediaId: ids.episodeMedia,
      files: [FILE],
      audios: [AUDIO],
      intro: null,
      warm: WARM,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/media-tracks?mid=${ids.episodeMedia}`,
    });

    expect(res.statusCode).toBe(200);
    const tracks = mediaTracksSchema.parse(res.json());
    expect(tracks.audios).toHaveLength(1);
    expect(tracks.audios[0]!.masterUrl).toContain("index=3&audio=1");
  });

  it("пусто, когда прогрева нет: плеер остаётся на базовой дорожке", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const res = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.movie}/media-tracks?mid=${ids.movieMedia}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mediaTracksSchema.parse(res.json()).audios).toEqual([]);
  });
});
