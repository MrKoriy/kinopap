import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  SourceAudioInfo,
  SourceInfo,
  SourceSubtitleInfo,
  SourceVideoInfo,
} from "../types";

const execFileAsync = promisify(execFile);

export interface FfmpegConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** preset libx264; в тестах ultrafast, в проде veryfast. */
  preset?: string;
  crf?: number;
  /** Длительность HLS-сегмента, сек. */
  hlsTime?: number;
  /** Таймаут ffprobe, мс (по умолчанию 30с). */
  probeTimeoutMs?: number;
  /** Таймаут транскода, мс (по умолчанию 4ч — длинные фильмы кодируются часами). */
  encodeTimeoutMs?: number;
  /** Таймаут генерации ассетов (постер/тумбы/спрайт/субтитры), мс. */
  assetTimeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
export const DEFAULT_ENCODE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_ASSET_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * execFile с таймаутом: зависший ffmpeg/ffprobe раньше занимал единственный
 * слот воркера навсегда (лок продлевается, event loop жив — BullMQ не
 * детектит stall). timeout у child_process посылает SIGTERM процессу.
 */
export function execWithTimeout(
  file: string,
  args: string[],
  timeoutMs: number,
  maxBuffer = 64 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { maxBuffer, timeout: timeoutMs });
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return Math.round((num / den) * 100) / 100;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  r_frame_rate?: string;
  tags?: {
    language?: string;
    title?: string;
    /** mp4 имя дорожки живёт в name/handler_name, а не в title. */
    name?: string;
    handler_name?: string;
  };
}

/** Имя дорожки из тегов: title (mkv), name/handler_name (mp4). */
function streamTitle(tags: RawStream["tags"]): string | null {
  return tags?.title ?? tags?.name ?? tags?.handler_name ?? null;
}

/** ffprobe → типизированная карточка медиафайла. */
export async function probeMedia(
  filePath: string,
  cfg: FfmpegConfig = {},
): Promise<SourceInfo> {
  const ffprobe = cfg.ffprobePath ?? "ffprobe";
  const { stdout } = await execWithTimeout(
    ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    cfg.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    32 * 1024 * 1024,
  );
  const raw = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string };
    streams?: RawStream[];
  };

  const video: SourceVideoInfo[] = [];
  const audio: SourceAudioInfo[] = [];
  const subtitles: SourceSubtitleInfo[] = [];

  for (const s of raw.streams ?? []) {
    const codec = s.codec_name ?? "unknown";
    if (s.codec_type === "video") {
      video.push({
        codec,
        width: s.width ?? 0,
        height: s.height ?? 0,
        fps: parseFps(s.r_frame_rate),
      });
    } else if (s.codec_type === "audio") {
      audio.push({
        codec,
        channels: s.channels ?? 0,
        lang: s.tags?.language ?? null,
        title: streamTitle(s.tags),
      });
    } else if (s.codec_type === "subtitle") {
      subtitles.push({
        codec,
        lang: s.tags?.language ?? null,
        title: streamTitle(s.tags),
      });
    }
  }

  return {
    ref: filePath,
    container: raw.format?.format_name ?? "unknown",
    durationSeconds: Number(raw.format?.duration ?? 0),
    video,
    audio,
    subtitles,
  };
}
