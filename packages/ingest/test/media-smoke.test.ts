/**
 * Smoke-тесты на РЕАЛЬНОМ ffmpeg: лестница качеств, тумбы, спрайт
 * и WebVTT действительно создаются на тестовом медиафайле.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildDubMaster,
  convertSubtitlesToVtt,
  generatePoster,
  generateSprite,
  generateThumbs,
  probeMedia,
  selectLadder,
  transcodeToHls,
} from "../src";

const execFileAsync = promisify(execFile);

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
    const { rungs } = await transcodeToHls(
      media.videoPath,
      outDir,
      720,
      [{ lang: "rus", title: "MVO" }],
      TEST_FFMPEG,
    );

    expect(rungs.map((r) => r.quality)).toEqual(["480p", "720p"]);
    for (const rung of rungs) {
      await stat(rung.playlistPath);
      expect(rung.segmentPaths.length).toBeGreaterThan(0);
      for (const seg of rung.segmentPaths) await stat(seg);

      // Реальные размеры и кодеки выхода — из ffprobe по сегменту.
      // Видео-варианты без аудио: звук живёт в аудио-рендitions.
      const probed = await probeMedia(rung.segmentPaths[0]!);
      expect(probed.video[0]?.height).toBe(rung.height);
      expect(probed.video[0]?.codec).toBe("h264");
      expect(probed.audio).toHaveLength(0);

      const playlist = await readFile(rung.playlistPath, "utf8");
      expect(playlist).toContain("#EXTM3U");
      expect(playlist).toContain(".ts");
    }
  });
});

/* ---------- Multi-audio HLS: аудио-группы и реальные различия дорожек ---------- */

/** Декод плейлиста в моно-PCM (s16le, 48кГц). */
async function decodePcm(playlistPath: string): Promise<Int16Array> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", playlistPath, "-f", "s16le", "-ac", "1", "-ar", "48000", "pipe:1"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const buf = stdout as unknown as Buffer;
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** Мощность сигнала на частоте (алгоритм Гёрцеля). */
function goertzelPower(samples: Int16Array, freq: number, sampleRate: number): number {
  const n = Math.min(samples.length, sampleRate); // 1 секунды достаточно
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = samples[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

describe("multi-audio HLS (реальный ffmpeg)", () => {
  it("мастер-плейлист с audio group и двумя рендitions дубляжа", async () => {
    const outDir = await makeTmpDir("zal-ma-");
    const { masterPlaylistPath, rungs, audioRenditions } = await transcodeToHls(
      media.dualPath,
      outDir,
      720,
      [
        { lang: "rus", title: "MVO Dublyazh" },
        { lang: "eng", title: "AVO Original" },
      ],
      TEST_FFMPEG,
    );

    const master = await readFile(masterPlaylistPath, "utf8");

    // Две аудио-рендitions в одной группе, с языками и DEFAULT у первой.
    expect(master.match(/TYPE=AUDIO/g)).toHaveLength(2);
    expect(master).toContain('GROUP-ID="group_aud"');
    expect(master).toContain('LANGUAGE="rus"');
    expect(master).toContain('LANGUAGE="eng"');
    expect(master).toContain("DEFAULT=YES");
    expect(master).toContain("DEFAULT=NO");

    // Все видео-варианты ссылаются на аудио-группу.
    const streamInfs = master.match(/#EXT-X-STREAM-INF.*/g) ?? [];
    expect(streamInfs).toHaveLength(rungs.length);
    for (const line of streamInfs) {
      expect(line).toContain('AUDIO="group_aud"');
      expect(line).toContain("avc1");
      expect(line).toContain("mp4a.40.2");
    }

    // URI из мастера реально существуют.
    for (const r of audioRenditions) await stat(r.playlistPath);
    const uris = [...master.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]!);
    expect(uris).toHaveLength(2);
    for (const uri of uris) await stat(path.join(outDir, uri));

    // Персональные мастера дубляжей: одна аудио-рендition, все видео-варианты.
    for (const r of audioRenditions) {
      await stat(r.masterPlaylistPath!);
      const dub = await readFile(r.masterPlaylistPath!, "utf8");
      expect(dub.match(/TYPE=AUDIO/g)).toHaveLength(1);
      expect(dub).toContain(`NAME="${r.dirName}"`);
      expect(dub).toContain("DEFAULT=YES");
      expect(dub).not.toContain("DEFAULT=NO");
      expect(dub.match(/#EXT-X-STREAM-INF/g)).toHaveLength(rungs.length);
      for (const uri of [...dub.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]!)) {
        await stat(path.join(outDir, uri));
      }
    }
  });

  it("дорожки действительно различаются: 300Гц против 3000Гц", async () => {
    const outDir = await makeTmpDir("zal-ma2-");
    const { audioRenditions } = await transcodeToHls(
      media.dualPath,
      outDir,
      720,
      [
        { lang: "rus", title: "MVO Dublyazh" },
        { lang: "eng", title: "AVO Original" },
      ],
      TEST_FFMPEG,
    );
    expect(audioRenditions).toHaveLength(2);

    const [a, b] = await Promise.all([
      decodePcm(audioRenditions[0]!.playlistPath),
      decodePcm(audioRenditions[1]!.playlistPath),
    ]);
    const sr = 48000;
    // Мощность на своей частоте должна доминировать в каждой дорожке.
    expect(goertzelPower(a, 300, sr)).toBeGreaterThan(goertzelPower(a, 3000, sr) * 10);
    expect(goertzelPower(b, 3000, sr)).toBeGreaterThan(goertzelPower(b, 300, sr) * 10);
  });
});

describe("buildDubMaster (персональный мастер дубляжа)", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio-0-rus",DEFAULT=YES,LANGUAGE="rus",URI="audio-0-rus/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio-1-eng",DEFAULT=NO,LANGUAGE="eng",URI="audio-1-eng/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO="aud"',
    "720p/index.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=854x480,AUDIO="aud"',
    "480p/index.m3u8",
  ].join("\n");

  it("оставляет одну дорожку, делает её DEFAULT и сохраняет видео", () => {
    const dub = buildDubMaster(master, "audio-1-eng");
    expect(dub).toContain('NAME="audio-1-eng"');
    expect(dub).not.toContain("audio-0-rus");
    expect(dub).toContain("DEFAULT=YES");
    expect(dub).not.toContain("DEFAULT=NO");
    expect(dub.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
    expect(dub).toContain("720p/index.m3u8");
    expect(dub).toContain("480p/index.m3u8");
  });

  it("первая дорожка уже DEFAULT — остаётся как есть", () => {
    const dub = buildDubMaster(master, "audio-0-rus");
    expect(dub.match(/TYPE=AUDIO/g)).toHaveLength(1);
    expect(dub).toContain('NAME="audio-0-rus"');
    expect(dub).toContain("LANGUAGE=\"rus\"");
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
