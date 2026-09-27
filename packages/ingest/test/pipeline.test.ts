/**
 * End-to-end: LocalFolder → ffprobe → ffmpeg → публикация в каталог.
 * Реальный ffmpeg, реальные миграции на PGlite.
 */
import { stat } from "node:fs/promises";
import {
  audioTracks,
  type Db,
  episodes,
  itemGenres,
  items,
  media,
  mediaFiles,
  seasons,
  subtitles,
} from "@zal/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  type IngestPipelineDeps,
  LocalFolderConnector,
  LocalStorage,
  type MetadataEnricher,
  runIngest,
  UrlSourceConnector,
} from "../src";
import { createTestDb, makeTestMedia, makeTmpDir, TEST_FFMPEG } from "./helpers";

function makeDeps(db: Db, mediaDir: string, storageRoot: string): IngestPipelineDeps {
  const enricher: MetadataEnricher = {
    kind: "fake",
    find: async () => [
      {
        plot: "Хакер узнаёт правду о мире.",
        originalTitle: "The Matrix",
        tmdbId: 603,
        tmdbRating: 8.2,
        tmdbVotes: 25000,
        posterMedium: "https://img.tmdb.org/w500/matrix.jpg",
        genres: ["Фантастика"],
        countries: ["США"],
      },
    ],
  };
  return {
    db,
    storage: new LocalStorage(storageRoot, "http://cdn.test/m"),
    connectors: {
      local: new LocalFolderConnector(mediaDir, TEST_FFMPEG),
      url: new UrlSourceConnector({ ...TEST_FFMPEG, allowPrivateHosts: true }),
    },
    enricher,
    ffmpeg: TEST_FFMPEG,
  };
}

describe("runIngest (полный пайплайн)", () => {
  it("ingest → ffmpeg → каталог: файлы и записи действительно созданы", async () => {
    const src = await makeTestMedia();
    const db = await createTestDb();
    const storageRoot = await makeTmpDir("zal-store-");
    const deps = makeDeps(db, src.dir, storageRoot);

    const result = await runIngest(deps, {
      source: {
        type: "local",
        ref: "embedded.mp4",
        subtitleRefs: ["sample.srt"],
      },
      item: { type: "movie", title: "Матрица", year: 1999 },
      ladders: ["480p", "720p"],
    });

    // Запись в каталоге.
    const itemRows = await db.select().from(items).where(eq(items.id, result.itemId));
    const item = itemRows[0]!;
    expect(item.title).toBe("Матрица");
    expect(item.year).toBe(1999);
    expect(item.quality).toBe(720);

    // Обогащение применено.
    expect(item.plot).toBe("Хакер узнаёт правду о мире.");
    expect(item.originalTitle).toBe("The Matrix");
    expect(item.tmdbId).toBe(603);
    expect(item.tmdbRating).toBe(8.2);
    const genreLinks = await db
      .select()
      .from(itemGenres)
      .where(eq(itemGenres.itemId, result.itemId));
    expect(genreLinks).toHaveLength(1);

    // Media со спрайтом.
    const mediaRows = await db.select().from(media).where(eq(media.id, result.mediaId));
    const m = mediaRows[0]!;
    expect(m.spriteMeta?.tileWidth).toBe(160);
    expect(m.spriteMeta?.tileHeight).toBe(90);
    expect(m.spriteMeta?.count).toBeGreaterThanOrEqual(1);
    expect(m.posterKey).toContain("poster.jpg");

    // Лестница качеств записана.
    const files = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaId, result.mediaId))
      .orderBy(mediaFiles.height);
    expect(files.map((f) => f.quality)).toEqual(["480p", "720p"]);
    expect(files.every((f) => f.codec === "h264")).toBe(true);

    // Аудиодорожки из ffprobe, с ключом рендitions в HLS-мастере.
    const audios = await db
      .select()
      .from(audioTracks)
      .where(eq(audioTracks.mediaId, result.mediaId));
    expect(audios).toHaveLength(1);
    expect(audios[0]).toMatchObject({ codec: "aac", lang: "und", dubType: "original" });
    expect(audios[0]!.fileKey).toContain("audio-0-und");

    // Субтитры: внешний + встроенный → WebVTT.
    const subs = await db
      .select()
      .from(subtitles)
      .where(eq(subtitles.mediaId, result.mediaId));
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.embed).sort()).toEqual([false, true]);
    expect(subs.find((s) => s.embed)?.lang).toBe("rus");

    // Файлы реально лежат в хранилище по ключам из БД.
    // HLS у всех рунгов один — мастер с audio groups.
    expect(new Set(files.map((f) => f.hlsKey)).size).toBe(1);
    expect(files[0]!.hlsKey).toContain("master.m3u8");
    for (const f of files) {
      await stat(deps.storage.resolveDir(f.fileKey));
      await stat(deps.storage.resolveDir(f.hlsKey!));
    }
    for (const a of audios) await stat(deps.storage.resolveDir(a.fileKey!));
    await stat(deps.storage.resolveDir(m.posterKey!));
    await stat(deps.storage.resolveDir(m.spriteKey!));
    for (const s of subs) {
      await stat(deps.storage.resolveDir(s.fileKey!));
    }

    // Повторный ingest другого источника — новая media у того же item'а.
    const again = await runIngest(deps, {
      source: { type: "local", ref: "sample.mp4" },
      item: { type: "movie", title: "Матрица", year: 1999 },
    });
    expect(again.itemId).toBe(result.itemId);
    expect(again.mediaId).not.toBe(result.mediaId);
  });

  it("повторный ingest того же источника обновляет media, а не дублирует", async () => {
    const src = await makeTestMedia();
    const db = await createTestDb();
    const deps = makeDeps(db, src.dir, await makeTmpDir("zal-store-"));

    const request = {
      source: { type: "local" as const, ref: "sample.mp4" },
      item: { type: "movie" as const, title: "Дюна", year: 2021 },
      ladders: ["480p"] as ("480p")[],
    };
    const first = await runIngest(deps, request);
    const second = await runIngest(deps, request);

    // Тот же источник → та же media-строка, файлы заменены.
    expect(second.itemId).toBe(first.itemId);
    expect(second.mediaId).toBe(first.mediaId);

    const mediaRows = await db.select().from(media).where(eq(media.itemId, first.itemId));
    expect(mediaRows).toHaveLength(1);

    const files = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaId, first.mediaId));
    expect(files).toHaveLength(1);
    expect(files[0]!.fileKey).toBe(`${second.baseKey}/480p/index.m3u8`);

    // Аудио/субтитры тоже не дублируются.
    const audios = await db
      .select()
      .from(audioTracks)
      .where(eq(audioTracks.mediaId, first.mediaId));
    expect(audios).toHaveLength(1);
  });

  it("дубляжи укладываются в мастер как отдельные аудио-рендitions", async () => {
    const src = await makeTestMedia();
    const db = await createTestDb();
    const deps = makeDeps(db, src.dir, await makeTmpDir("zal-store-"));

    const result = await runIngest(deps, {
      source: { type: "local", ref: "dual.mp4" },
      item: { type: "movie", title: "Два голоса", year: 2026 },
      ladders: ["480p"],
    });

    const audios = await db
      .select()
      .from(audioTracks)
      .where(eq(audioTracks.mediaId, result.mediaId))
      .orderBy(audioTracks.trackIndex);
    expect(audios.map((a) => [a.dubType, a.lang])).toEqual([
      ["mvo", "rus"],
      ["avo", "eng"],
    ]);
    expect(audios.map((a) => a.fileKey)).toEqual([
      `${result.baseKey}/audio-0-rus/index.m3u8`,
      `${result.baseKey}/audio-1-eng/index.m3u8`,
    ]);

    // Мастер и обе рендitions реально лежат в хранилище.
    await stat(deps.storage.resolveDir(result.masterKey));
    for (const key of result.audioKeys) await stat(deps.storage.resolveDir(key));
  });

  it("эпизод сериала публикуется с сезоном и эпизодом", async () => {
    const src = await makeTestMedia();
    const db = await createTestDb();
    const deps = makeDeps(db, src.dir, await makeTmpDir("zal-store-"));

    const result = await runIngest(deps, {
      source: { type: "local", ref: "sample.mp4" },
      item: { type: "serial", title: "Игра престолов", year: 2011 },
      episode: { seasonNumber: 1, episodeNumber: 1, title: "Зима близко" },
    });

    const seasonRows = await db
      .select()
      .from(seasons)
      .where(eq(seasons.itemId, result.itemId));
    expect(seasonRows[0]?.number).toBe(1);

    const epRows = await db
      .select()
      .from(episodes)
      .where(eq(episodes.seasonId, seasonRows[0]!.id));
    expect(epRows[0]).toMatchObject({ number: 1, title: "Зима близко" });
  });
});
