/**
 * Ассеты плеера: тумбы (постер + периодические кадры), спрайт для
 * скраббинга и конвертация субтитров в WebVTT.
 */
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ASSET_TIMEOUT_MS,
  execWithTimeout,
  type FfmpegConfig,
} from "./probe";

/** Все ассеты проходят с таймаутом: зависший ffmpeg не вешает воркер. */
function runAsset(
  cfg: FfmpegConfig,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execWithTimeout(
    cfg.ffmpegPath ?? "ffmpeg",
    ["-y", "-nostats", "-v", "warning", ...args],
    cfg.assetTimeoutMs ?? DEFAULT_ASSET_TIMEOUT_MS,
    32 * 1024 * 1024,
  );
}

/**
 * fps=1/N не выдаёт кадров, если N больше длительности файла —
 * зажимаем интервал длительностью, чтобы тумбы/спрайт были гарантированно.
 */
function effectiveInterval(intervalSeconds: number, durationSeconds: number): number {
  return Math.min(intervalSeconds, Math.max(durationSeconds, 0.1));
}

/** Потолок тайлов спрайта: длинный фильм иначе даёт 1440+ тайлов
 * и JPEG ~6000px, который плеер тянет с трудом. */
export const MAX_TILES = 600;

/**
 * Раскладка тайлов спрайта: интервал и число тайлов. Если тайлов
 * получается больше MAX_TILES — интервал пересчитывается как
 * ceil(длительность / MAX_TILES), чтобы уложиться в потолок.
 */
export function spriteTileLayout(
  durationSeconds: number,
  intervalSeconds: number,
): { intervalSeconds: number; count: number } {
  let interval = effectiveInterval(intervalSeconds, durationSeconds);
  let count = Math.max(1, Math.floor(durationSeconds / interval));
  if (count > MAX_TILES) {
    interval = Math.max(1, Math.ceil(durationSeconds / MAX_TILES));
    count = Math.max(1, Math.floor(durationSeconds / interval));
  }
  return { intervalSeconds: interval, count };
}

export interface SpriteMetaResult {
  intervalSeconds: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  count: number;
}

/** Постер: кадр в seekSeconds, ширина width (по умолчанию 640). */
export async function generatePoster(
  sourcePath: string,
  outPath: string,
  cfg: FfmpegConfig & { seekSeconds?: number; width?: number } = {},
): Promise<void> {
  await runAsset(cfg, [
    "-ss", String(cfg.seekSeconds ?? 1),
    "-i", sourcePath,
    "-frames:v", "1",
    // out_range=full — mjpeg требует полного диапазона YUV.
    "-vf", `scale=w=${cfg.width ?? 640}:h=-2:out_range=full`,
    outPath,
  ]);
}

/** Тумбы: кадр каждые intervalSeconds в outDir/thumb_%03d.jpg. */
export async function generateThumbs(
  sourcePath: string,
  outDir: string,
  cfg: FfmpegConfig & {
    intervalSeconds?: number;
    width?: number;
    durationSeconds?: number;
  } = {},
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const interval = effectiveInterval(
    cfg.intervalSeconds ?? 5,
    cfg.durationSeconds ?? Number.MAX_SAFE_INTEGER,
  );
  await runAsset(cfg, [
    "-i", sourcePath,
    "-vf", `fps=1/${interval},scale=w=${cfg.width ?? 320}:h=-2:out_range=full`,
    path.join(outDir, "thumb_%03d.jpg"),
  ]);
  return (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort().map((f) => path.join(outDir, f));
}

/**
 * Спрайт для скраббинга: тайл-сетка кадров + метаданные раскладки,
 * чтобы плеер знал, какой тайл какому моменту соответствует.
 */
export async function generateSprite(
  sourcePath: string,
  outPath: string,
  opts: FfmpegConfig & {
    durationSeconds: number;
    intervalSeconds?: number;
    tileWidth?: number;
    sourceWidth: number;
    sourceHeight: number;
  },
): Promise<SpriteMetaResult> {
  const { intervalSeconds: interval, count } = spriteTileLayout(
    opts.durationSeconds,
    opts.intervalSeconds ?? 5,
  );
  const tileWidth = opts.tileWidth ?? 160;
  const tileHeight = Math.max(2, Math.round((tileWidth * opts.sourceHeight) / opts.sourceWidth / 2) * 2);
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);

  await runAsset(opts, [
    "-i", sourcePath,
    "-vf", `fps=1/${interval},scale=w=${tileWidth}:h=${tileHeight}:out_range=full,tile=${columns}x${rows}`,
    "-frames:v", "1",
    outPath,
  ]);

  return { intervalSeconds: interval, tileWidth, tileHeight, columns, rows, count };
}

/** Любые субтитры → WebVTT (ffmpeg сам понимает srt/ass/ssa). */
export async function convertSubtitlesToVtt(
  inputPath: string,
  outputPath: string,
  cfg: FfmpegConfig = {},
): Promise<void> {
  await runAsset(cfg, ["-i", inputPath, outputPath]);
}

/** Извлечь встроенный субтрек (по индексу) в WebVTT. */
export async function extractEmbeddedSubtitles(
  sourcePath: string,
  outPath: string,
  streamIndex: number,
  cfg: FfmpegConfig = {},
): Promise<void> {
  await runAsset(cfg, [
    "-i", sourcePath,
    "-map", `0:s:${streamIndex}`,
    outPath,
  ]);
}
