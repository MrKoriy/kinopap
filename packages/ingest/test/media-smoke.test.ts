/**
 * Smoke-тесты на РЕАЛЬНОМ ffmpeg: лестница качеств, тумбы, спрайт
 * и WebVTT действительно создаются на тестовом медиафайле.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  convertSubtitlesToVtt,
  generatePoster,
  generateSprite,
  generateThumbs,
  probeMedia,
  selectLadder,
  transcodeToHls,
} from "../src";
import { makeTestMedia, makeTmpDir, TEST_FFMPEG, type TestMedia } from "./helpers";

let media: TestMedia;

beforeAll(async () => {
  media = await makeTestMedia();
});

describe("probeMedia (ffprobe)", () => {
  it("читает тестовый файл", async () => {
    const info = await probeMedia(media.videoPath);
    expect(info.durationSeconds).toBeCloseTo(2, 1);
    expect(info.video[0]).toMatchObject({ codec: "h264", width: 1280, height: 720 });
    expect(info.audio[0]).toMatchObject({ codec: "aac" });
  });
});

describe("selectLadder", () => {
  it("не апскейлит, но всегда оставляет рунг", () => {
    expect(selectLadder(720).map((r) => r.name)).toEqual(["480p", "720p"]);
    expect(selectLadder(1080).map((r) => r.name)).toEqual(["480p", "720p", "1080p"]);
    expect(selectLadder(200).map((r) => r.name)).toEqual(["480p"]);
    expect(selectLadder(1080, ["720p", "1080p"]).map((r) => r.name)).toEqual([
      "720p",
      "1080p",
    ]);
  });
});

describe("transcodeToHls (реальный ffmpeg)", () => {
  it("создаёт лестницу 480p+720p с сегментами и верными кодеками", async () => {
    const outDir = await makeTmpDir("zal-hls-");
    const rungs = await transcodeToHls(media.videoPath, outDir, 720, TEST_FFMPEG);

    expect(rungs.map((r) => r.quality)).toEqual(["480p", "720p"]);
    for (const rung of rungs) {
      await stat(rung.playlistPath);
      expect(rung.segmentPaths.length).toBeGreaterThan(0);
      for (const seg of rung.segmentPaths) await stat(seg);

      // Реальные размеры и кодеки выхода — из ffprobe по сегменту.
      const probed = await probeMedia(rung.segmentPaths[0]!);
      expect(probed.video[0]?.height).toBe(rung.height);
      expect(probed.video[0]?.codec).toBe("h264");
      expect(probed.audio[0]?.codec).toBe("aac");

      const playlist = await readFile(rung.playlistPath, "utf8");
      expect(playlist).toContain("#EXTM3U");
      expect(playlist).toContain(".ts");
    }
  });
});

describe("тумбы и постер", () => {
  it("generatePoster создаёт jpg", async () => {
    const out = path.join(await makeTmpDir("zal-poster-"), "poster.jpg");
    await generatePoster(media.videoPath, out, { ...TEST_FFMPEG, width: 640 });
    const probed = await probeMedia(out);
    expect(probed.video[0]?.codec).toBe("mjpeg");
    expect(probed.video[0]?.width).toBe(640);
  });

  it("generateThumbs создаёт кадры", async () => {
    const outDir = path.join(await makeTmpDir("zal-thumbs-"), "thumbs");
    const thumbs = await generateThumbs(media.videoPath, outDir, {
      ...TEST_FFMPEG,
      intervalSeconds: 1,
    });
    expect(thumbs.length).toBeGreaterThanOrEqual(1);
    for (const t of thumbs) await stat(t);
  });
});

describe("спрайт для скраббинга", () => {
  it("создаёт тайл-сетку с консистентными метаданными", async () => {
    const out = path.join(await makeTmpDir("zal-sprite-"), "sprite.jpg");
    const meta = await generateSprite(media.videoPath, out, {
      ...TEST_FFMPEG,
      durationSeconds: 2,
      intervalSeconds: 1,
      tileWidth: 160,
      sourceWidth: 1280,
      sourceHeight: 720,
    });

    expect(meta.count).toBe(2);
    expect(meta.columns * meta.rows).toBeGreaterThanOrEqual(meta.count);

    const probed = await probeMedia(out);
    expect(probed.video[0]?.codec).toBe("mjpeg");
    expect(probed.video[0]?.width).toBe(meta.columns * meta.tileWidth);
    expect(probed.video[0]?.height).toBe(meta.rows * meta.tileHeight);
    // 16:9 тайл не квадратный
    expect(meta.tileHeight).toBe(90);
  });
});

describe("WebVTT", () => {
  it("конвертирует srt → vtt с сохранением текста", async () => {
    const out = path.join(await makeTmpDir("zal-vtt-"), "subs.vtt");
    await convertSubtitlesToVtt(media.subPath, out);
    const text = await readFile(out, "utf8");
    expect(text).toContain("WEBVTT");
    expect(text).toContain("Привет, мир");
    expect(text).toContain("Тест субтитров");
  });
});
