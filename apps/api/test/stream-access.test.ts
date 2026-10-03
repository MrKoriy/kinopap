/**
 * Доступ к потокам: media-links/media-tracks открыты и гостям,
 * ссылки на /gst подписываются для nginx secure_link.
 */
import type { MediaFile } from "@zal/api-client";
import { mediaLinksSchema } from "@zal/api-client";
import { saveSource } from "@zal/db";
import { describe, expect, it } from "vitest";
import { gstSignature, signGstUrl } from "../src/lib/stream-links";
import { makeFixtures, memberAuth } from "./fixtures";
import { createTestApp } from "./setup";

const HASH = "b".repeat(40);
const SECRET = "gst-secret-0123456789abcdef-0123456789";

const FILE: MediaFile = {
  quality: "1080p WEB-DL",
  qualityId: 1080,
  width: 1920,
  height: 1080,
  codec: "h264",
  bitrate: null,
  sizeBytes: null,
  urls: {
    http: `/stream?link=${HASH}&index=2&play`,
    hls: `/gst/${HASH}/master.m3u8?index=2&audio=0`,
  },
};

describe("media-links/media-tracks: открыты гостям", () => {
  it("гость получает ссылки из кэша резолва без входа", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    await saveSource(db, {
      itemId: ids.movie,
      mediaId: ids.movieMedia,
      files: [FILE],
      audios: [],
      intro: null,
      warm: null,
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.movie}/media-links?mid=${ids.movieMedia}`,
    });
    expect(res.statusCode).toBe(200);
    const links = mediaLinksSchema.parse(res.json());
    expect(links.files).toHaveLength(1);
  });

  it("media-tracks с чужой парой (item, media) — 404 до любого резолва", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);
    const res = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/media-tracks?mid=${ids.movieMedia}`,
      headers: await memberAuth(app, db),
    });
    expect(res.statusCode).toBe(404);
  });

  it("несуществующий item — 404, а не 500", async () => {
    const { app, db } = await createTestApp();
    await makeFixtures(db);
    const res = await app.inject({
      method: "GET",
      url: "/v1/items/999999/media-links?mid=1",
      headers: await memberAuth(app, db),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("подпись ссылок /gst", () => {
  it("формат совпадает с nginx secure_link_md5 и срок округлён до часа", () => {
    const now = Date.UTC(2026, 9, 3, 10, 15);
    const signed = signGstUrl(`/gst/${HASH}/master.m3u8?index=1&audio=0`, SECRET, now);
    const m = signed.match(/^\/gst-s\/(\d+)\/([\w-]+)\/([0-9a-f]{40})\/master\.m3u8\?index=1&audio=0$/);
    expect(m).not.toBeNull();
    const expires = Number(m![1]);
    expect(expires % 3600).toBe(0);
    expect(expires * 1000).toBeGreaterThan(now + 11 * 3600 * 1000);
    expect(m![2]).toBe(gstSignature(expires, HASH, SECRET));
    expect(m![2]).not.toContain("=");
  });

  it("без секрета и для не-gst ссылок URL не меняется", () => {
    expect(signGstUrl(`/gst/${HASH}/master.m3u8`, undefined)).toBe(`/gst/${HASH}/master.m3u8`);
    expect(signGstUrl("/media/a/index.m3u8", SECRET)).toBe("/media/a/index.m3u8");
  });

  it("media-links отдаёт подписанные ссылки, кэш в БД остаётся чистым", async () => {
    const { app, db } = await createTestApp({ env: { GST_LINK_SECRET: SECRET } });
    const ids = await makeFixtures(db);
    await saveSource(db, {
      itemId: ids.serial,
      mediaId: ids.episodeMedia,
      files: [FILE],
      audios: [],
      intro: null,
      warm: { hash: HASH, fileIndex: 2, magnet: `magnet:?xt=urn:btih:${HASH}`, title: "t" },
    });
    const auth = await memberAuth(app, db);
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/items/${ids.serial}/media-links?mid=${ids.episodeMedia}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const links = mediaLinksSchema.parse(res.json());
      // Ровно один префикс подписи: повторный запрос из L1-кэша не подписывает дважды.
      expect(links.files[0]!.urls.hls).toMatch(new RegExp(`^/gst-s/\\d+/[\\w-]+/${HASH}/master\\.m3u8`));
      expect(links.files[0]!.urls.hls!.match(/gst-s/g)).toHaveLength(1);
    }
  });
});
