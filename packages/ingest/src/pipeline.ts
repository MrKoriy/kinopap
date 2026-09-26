/**
 * Пайплайн ingest: pull → ffprobe → ffmpeg (HLS-лестница, тумбы, спрайт,
 * WebVTT) → публикация в каталог через @zal/db → обогащение метаданными.
 */
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AudioDubType, IngestRequest } from "@zal/api-client";
import {
  applyEnrichment,
  publishIngest,
  type Db,
  type PublishIngestInput,
} from "@zal/db";
import {
  convertSubtitlesToVtt,
  extractEmbeddedSubtitles,
  generatePoster,
  generateSprite,
  generateThumbs,
} from "./media/assets";
import { probeMedia, type FfmpegConfig } from "./media/probe";
import { transcodeToHls } from "./media/transcode";
import { slugify, type MediaStorage } from "./storage";
import type { MetadataEnricher, SourceAudioInfo, SourceConnector } from "./types";

export interface IngestPipelineDeps {
  db: Db;
  storage: MediaStorage;
  connectors: { local: SourceConnector; url: SourceConnector };
  enricher?: MetadataEnricher;
  ffmpeg?: FfmpegConfig;
}

export interface IngestPipelineResult {
  itemId: number;
  mediaId: number;
  baseKey: string;
  rungKeys: string[];
}

/** Тип озвучки из тегов дорожки; одиночка — оригинал. */
export function inferDubType(
  audio: SourceAudioInfo[],
  index: number,
): AudioDubType {
  const a = audio[index];
  const tags = `${a?.title ?? ""} ${a?.lang ?? ""}`.toLowerCase();
  if (/\bmvo\b|многоголос/.test(tags)) return "mvo";
  if (/\buvo\b|одноголос/.test(tags)) return "uvo";
  if (/\bdvo\b|двухголос/.test(tags)) return "dvo";
  if (/\bavo\b|авторск/.test(tags)) return "avo";
  if (/original|оригинал/.test(tags)) return "original";
  return audio.length > 1 ? "mvo" : "original";
}

function langFromFilename(p: string): string {
  const m = path.basename(p).match(/(?:^|[._-])([a-z]{2,3})\.[a-z0-9]+$/i);
  return m?.[1]?.toLowerCase() ?? "und";
}

export async function runIngest(
  deps: IngestPipelineDeps,
  request: IngestRequest,
): Promise<IngestPipelineResult> {
  const connector = deps.connectors[request.source.type];
  const cfg = deps.ffmpeg ?? {};
  const workDir = await mkdtemp(path.join(os.tmpdir(), "zal-ingest-"));

  try {
    const pulled = await connector.pull(request.source.ref, {
      workDir,
      subtitleRefs: request.source.subtitleRefs,
    });

    const info = await probeMedia(pulled.filePath, cfg);
    const video = info.video[0];
    if (!video || !info.durationSeconds) {
      throw new Error("ingest: no video stream or zero duration");
    }

    // 1. Видео: HLS-лестница (без апскейла).
    const rungs = await transcodeToHls(pulled.filePath, path.join(workDir, "hls"), video.height, {
      ...cfg,
      ladder: request.ladders,
    });

    // 2. Ассеты плеера: постер, тумбы, спрайт для скраббинга.
    const posterPath = path.join(workDir, "poster.jpg");
    await generatePoster(pulled.filePath, posterPath, cfg);
    const thumbsDir = path.join(workDir, "thumbs");
    await generateThumbs(pulled.filePath, thumbsDir, {
      ...cfg,
      durationSeconds: info.durationSeconds,
    });
    const spritePath = path.join(workDir, "sprite.jpg");
    const spriteMeta = await generateSprite(pulled.filePath, spritePath, {
      ...cfg,
      durationSeconds: info.durationSeconds,
      sourceWidth: video.width,
      sourceHeight: video.height,
    });

    // 3. Субтитры: внешние и встроенные → WebVTT.
    const subsDir = path.join(workDir, "subs");
    await mkdir(subsDir, { recursive: true });
    const vttFiles: { lang: string; filePath: string; embed: boolean; title: string | null }[] = [];
    for (const [i, s] of pulled.subtitlePaths.entries()) {
      const out = path.join(subsDir, `external_${i}.vtt`);
      await convertSubtitlesToVtt(s.path, out, cfg);
      vttFiles.push({
        lang: s.lang ?? langFromFilename(s.path),
        filePath: out,
        embed: false,
        title: path.basename(s.path),
      });
    }
    for (const [i, s] of info.subtitles.entries()) {
      const out = path.join(subsDir, `embedded_${i}.vtt`);
      await extractEmbeddedSubtitles(pulled.filePath, out, i, cfg);
      vttFiles.push({
        lang: s.lang ?? "und",
        filePath: out,
        embed: true,
        title: s.title,
      });
    }

    // 4. Ключи хранилища и перенос результатов (до записи в БД).
    const baseKey = `ingest/${Date.now()}-${slugify(request.item.title)}`;
    const dest = deps.storage.resolveDir(baseKey);
    await mkdir(dest, { recursive: true });
    await cp(path.join(workDir, "hls"), dest, { recursive: true });
    await cp(posterPath, path.join(dest, "poster.jpg"));
    await cp(spritePath, path.join(dest, "sprite.jpg"));
    await cp(thumbsDir, path.join(dest, "thumbs"), { recursive: true });
    if (vttFiles.length) {
      await mkdir(path.join(dest, "subs"), { recursive: true });
      for (const v of vttFiles) {
        await cp(v.filePath, path.join(dest, "subs", path.basename(v.filePath)));
      }
    }

    // 5. Публикация записи в каталог через слой @zal/db.
    const publish: PublishIngestInput = {
      item: {
        type: request.item.type,
        title: request.item.title,
        originalTitle: request.item.originalTitle ?? null,
        year: request.item.year ?? null,
        plot: request.item.plot ?? null,
        runtimeTotal: Math.round(info.durationSeconds),
        quality: Math.max(...rungs.map((r) => r.height), video.height),
        langs: info.audio.length || 1,
        hasAc3: info.audio.some((a) => a.codec === "ac3"),
      },
      media: {
        title: request.item.title,
        duration: Math.round(info.durationSeconds),
        posterKey: `${baseKey}/poster.jpg`,
        spriteKey: `${baseKey}/sprite.jpg`,
        spriteMeta: {
          intervalSeconds: spriteMeta.intervalSeconds,
          tileWidth: spriteMeta.tileWidth,
          tileHeight: spriteMeta.tileHeight,
          columns: spriteMeta.columns,
          rows: spriteMeta.rows,
          count: spriteMeta.count,
        },
        episode: request.episode ?? null,
      },
      files: rungs.map((r) => ({
        quality: r.quality,
        qualityId: r.qualityId,
        width: r.width,
        height: r.height,
        codec: "h264",
        bitrate: r.videoBitrateKbps * 1000,
        fileKey: `${baseKey}/${r.dirName}/index.m3u8`,
        hlsKey: `${baseKey}/${r.dirName}/index.m3u8`,
      })),
      audios: info.audio.map((a, i) => ({
        trackIndex: i + 1,
        codec: a.codec,
        channels: a.channels,
        lang: a.lang ?? "und",
        dubType: inferDubType(info.audio, i),
        authorTitle: a.title ?? null,
      })),
      subtitles: vttFiles.map((v) => ({
        lang: v.lang,
        embed: v.embed,
        fileKey: `${baseKey}/subs/${path.basename(v.filePath)}`,
        title: v.title,
      })),
    };
    const { itemId, mediaId } = await publishIngest(deps.db, publish);

    // 6. Обогащение метаданными (например TMDb).
    if (deps.enricher) {
      const found = await deps.enricher.find({
        title: request.item.title,
        year: request.item.year ?? null,
        type: request.item.type,
      });
      if (found[0]) await applyEnrichment(deps.db, itemId, found[0]);
    }

    return {
      itemId,
      mediaId,
      baseKey,
      rungKeys: rungs.map((r) => `${baseKey}/${r.dirName}/index.m3u8`),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await pulledCleanupGuard();
  }
}

// cleanup источника вызываем отдельно, чтобы не потерять ошибку pull
async function pulledCleanupGuard(): Promise<void> {
  // cleanup каждого pulled уже no-op у готовых коннекторов;
  // хук оставлен под плагины, которым нужно удалять временные файлы.
}
