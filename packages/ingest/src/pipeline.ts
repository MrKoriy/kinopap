/**
 * Пайплайн ingest: pull → ffprobe → ffmpeg (HLS-лестница, тумбы, спрайт,
 * WebVTT) → публикация в каталог через @zal/db → обогащение метаданными.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AudioDubType, IngestRequest } from "@zal/api-client";
import {
  applyEnrichment,
  type Db,
  type PublishIngestInput,
  publishIngest,
} from "@zal/db";
import {
  convertSubtitlesToVtt,
  extractEmbeddedSubtitles,
  generatePoster,
  generateSprite,
  generateThumbs,
} from "./media/assets";
import { type FfmpegConfig, probeMedia } from "./media/probe";
import { type AudioRenditionInput, transcodeToHls } from "./media/transcode";
import { type MediaStorage, slugify } from "./storage";
import type {
  MetadataEnricher,
  PulledSource,
  SourceAudioInfo,
  SourceConnector,
} from "./types";

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
  /** Мастер-плейлист с audio groups. */
  masterKey: string;
  rungKeys: string[];
  audioKeys: string[];
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

/** Текстовые субтитры: ffmpeg умеет конвертировать в WebVTT только их.
 * Растровые (PGS/DVB/VobSub) раньше валили весь ingest. */
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "sami",
  "microdvd", "subviewer", "subviewer1", "vplayer", "realtext", "stl",
  "pjs", "jacosub", "mpl2",
]);

export function isTextSubtitleCodec(codec: string): boolean {
  return TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

/** Ключ дедупа media: тот же источник (и тот же эпизод) → та же запись. */
export function mediaSourceKey(request: IngestRequest): string {
  const ep = request.episode
    ? `s${request.episode.seasonNumber}e${request.episode.episodeNumber}`
    : "";
  return createHash("sha256")
    .update(`${request.source.type}:${request.source.ref}:${ep}`)
    .digest("hex")
    .slice(0, 16);
}

/** Пульс рабочего каталога: mtime освежается вдвое чаще порога GC tmp-каталогов. */
const WORKDIR_HEARTBEAT_MS = 5 * 60 * 1000;

export async function runIngest(
  deps: IngestPipelineDeps,
  request: IngestRequest,
): Promise<IngestPipelineResult> {
  const connector = deps.connectors[request.source.type];
  const cfg = deps.ffmpeg ?? {};
  const workDir = await mkdtemp(path.join(os.tmpdir(), "zal-ingest-"));
  let pulled: PulledSource | null = null;

  // ffmpeg пишет в подкаталоги, mtime самого workDir стоит со времён
  // mkdtemp — часовой GC tmp-каталогов срезал бы активный многочасовой
  // encode. Держим mtime свежим, пока прогон жив.
  const dirHeartbeat = setInterval(() => {
    void utimes(workDir, new Date(), new Date()).catch(() => {});
  }, WORKDIR_HEARTBEAT_MS);
  dirHeartbeat.unref();

  try {
    pulled = await connector.pull(request.source.ref, {
      workDir,
      subtitleRefs: request.source.subtitleRefs,
    });

    const info = await probeMedia(pulled.filePath, cfg);
    const video = info.video[0];
    if (!video || !info.durationSeconds) {
      throw new Error("ingest: no video stream or zero duration");
    }

    // 1. Multi-audio HLS: видео-лестница + рендitions дубляжей + мастер
    //    с audio groups (без апскейла).
    const audioInputs: AudioRenditionInput[] = info.audio.map((a) => ({
      lang: a.lang,
      title: a.title,
    }));
    const { rungs, audioRenditions } = await transcodeToHls(
      pulled.filePath,
      path.join(workDir, "hls"),
      video.height,
      audioInputs,
      { ...cfg, ladder: request.ladders, durationSeconds: info.durationSeconds },
    );

    // 2. Ассеты плеера: постер, тумбы, спрайт для скраббинга.
    // Клик короче секунды не отдаёт кадр по умолтному seek=1 — пробуем 0.
    const posterPath = path.join(workDir, "poster.jpg");
    await generatePoster(pulled.filePath, posterPath, cfg);
    if (!(await stat(posterPath).then(() => true).catch(() => false))) {
      await generatePoster(pulled.filePath, posterPath, { ...cfg, seekSeconds: 0 });
    }
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

    // 3. Субтитры: внешние и встроенные → WebVTT. Ошибка одного трека
    // (растровый PGS/DVB, битый файл) пропускает трек, а не весь ingest.
    const subsDir = path.join(workDir, "subs");
    await mkdir(subsDir, { recursive: true });
    const vttFiles: { lang: string; filePath: string; embed: boolean; title: string | null }[] = [];
    for (const [i, s] of pulled.subtitlePaths.entries()) {
      const out = path.join(subsDir, `external_${i}.vtt`);
      try {
        await convertSubtitlesToVtt(s.path, out, cfg);
        vttFiles.push({
          lang: s.lang ?? langFromFilename(s.path),
          filePath: out,
          embed: false,
          title: path.basename(s.path),
        });
      } catch (err) {
        console.warn(`ingest: external subtitle ${i} skipped:`, String(err).slice(0, 200));
      }
    }
    for (const [i, s] of info.subtitles.entries()) {
      if (!isTextSubtitleCodec(s.codec)) {
        console.warn(
          `ingest: embedded subtitle ${i} (${s.codec}) skipped: raster codec`,
        );
        continue;
      }
      const out = path.join(subsDir, `embedded_${i}.vtt`);
      try {
        await extractEmbeddedSubtitles(pulled.filePath, out, i, cfg);
        vttFiles.push({
          lang: s.lang ?? "und",
          filePath: out,
          embed: true,
          title: s.title,
        });
      } catch (err) {
        console.warn(`ingest: embedded subtitle ${i} skipped:`, String(err).slice(0, 200));
      }
    }

    // 4. Ключи хранилища и перенос результатов (до записи в БД).
    // Каталог детерминирован по источнику: повторный ingest того же
    // источника (и того же эпизода) пишет поверх, а не плодит новый —
    // старый вариант не становится мусором до GC. Разные эпизоды/источники
    // дают разные ключи.
    const sourceKey = mediaSourceKey(request);
    const baseKey = `ingest/${sourceKey}-${slugify(request.item.title)}`;
    const dest = deps.storage.resolveDir(baseKey);
    // Атомарная публикация: собираем в версионированном каталоге, затем атомарно меняем symlink/rename.
    const versioned = `${dest}.next`;
    await mkdir(versioned, { recursive: true });
    await cp(path.join(workDir, "hls"), versioned, { recursive: true });
    await cp(posterPath, path.join(versioned, "poster.jpg"));
    await cp(spritePath, path.join(versioned, "sprite.jpg"));
    await cp(thumbsDir, path.join(versioned, "thumbs"), { recursive: true });
    if (vttFiles.length) {
      await mkdir(path.join(versioned, "subs"), { recursive: true });
      for (const v of vttFiles) {
        await cp(v.filePath, path.join(versioned, "subs", path.basename(v.filePath)));
      }
    }
    // Атомарный своп: старый каталог остаётся цел до успешного rename.
    const backup = `${dest}.prev`;
    try {
      const { rename } = await import("node:fs/promises");
      await rename(versioned, dest).catch(async () => {
        await rename(dest, backup).catch(() => {});
        await rename(versioned, dest);
      });
    } catch {
      // Fallback: если rename не сработал, оставляем versioned как есть и пробуем cp
      await cp(versioned, dest, { recursive: true, force: true }).catch(() => {});
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
        // Фолбэк-постеры: сгенерированный кадр, чтобы карточка не была пустой.
        // Обогащение (TMDb) перекроет их, если найдёт настоящие артворки.
        posterSmall: deps.storage.url(`${baseKey}/poster.jpg`),
        posterMedium: deps.storage.url(`${baseKey}/poster.jpg`),
        posterBig: deps.storage.url(`${baseKey}/poster.jpg`),
      },
      media: {
        title: request.item.title,
        duration: Math.round(info.durationSeconds),
        // Дедуп: повторный ingest того же источника обновляет эту же media,
        // а не плодит дубль (старые файлы на диске зачистит GC воркера).
        sourceKey,
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
        // HLS у всех рунгов один — мастер с audio groups и ABR.
        hlsKey: `${baseKey}/master.m3u8`,
      })),
      audios: info.audio.map((a, i) => ({
        trackIndex: i + 1,
        codec: a.codec,
        channels: a.channels,
        lang: a.lang ?? "und",
        dubType: inferDubType(info.audio, i),
        authorTitle: a.title ?? null,
        fileKey: audioRenditions[i]
          ? `${baseKey}/${audioRenditions[i]!.dirName}/index.m3u8`
          : null,
        masterKey: audioRenditions[i]
          ? `${baseKey}/master-${audioRenditions[i]!.dirName}.m3u8`
          : null,
      })),
      subtitles: vttFiles.map((v) => ({
        lang: v.lang,
        embed: v.embed,
        fileKey: `${baseKey}/subs/${path.basename(v.filePath)}`,
        title: v.title,
      })),
    };
    const { itemId, mediaId } = await publishIngest(deps.db, publish);

    // 6. Обогащение метаданными (например TMDb) — non-fatal: item/media уже
    // опубликованы, битый ключ/недоступный TMDb не должен переводить
    // живую задачу в failed.
    if (deps.enricher) {
      try {
        const found = await deps.enricher.find({
          title: request.item.title,
          year: request.item.year ?? null,
          type: request.item.type,
        });
        if (found[0]) await applyEnrichment(deps.db, itemId, found[0]);
      } catch (err) {
        console.warn("ingest: enrichment failed (non-fatal):", String(err).slice(0, 200));
      }
    }

    return {
      itemId,
      mediaId,
      baseKey,
      masterKey: `${baseKey}/master.m3u8`,
      rungKeys: rungs.map((r) => `${baseKey}/${r.dirName}/index.m3u8`),
      audioKeys: audioRenditions.map((a) => `${baseKey}/${a.dirName}/index.m3u8`),
    };
  } finally {
    clearInterval(dirHeartbeat);
    // cleanup источника вызываем в finally и на успехе, и на ошибке: он
    // чистит ВРЕМЕННЫЕ артефакты pull'а (у local — no-op, url качает прямо
    // в workDir). Опубликованное уже скопировано в storage, cleanup про него
    // не знает. Ошибку глотаем, чтобы не затирать исходную причину падения.
    await pulled?.cleanup().catch((err) => {
      console.warn("ingest: source cleanup failed (non-fatal):", String(err).slice(0, 200));
    });
    await rm(workDir, { recursive: true, force: true });
  }
}
