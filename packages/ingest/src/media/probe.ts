import { type ChildProcess, execFile } from "node:child_process";
import type {
  SourceAudioInfo,
  SourceInfo,
  SourceSubtitleInfo,
  SourceVideoInfo,
} from "../types";

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
 * Активные дочерние процессы (ffmpeg/ffprobe): трекинг для остановки при
 * shutdown воркера. add — на spawn, remove — на завершении процесса.
 */
export const activeChildProcesses = new Set<ChildProcess>();

/**
 * execFile с таймаутом: зависший ffmpeg/ffprobe раньше занимал единственный
 * слот воркера навсегда (лок продлевается, event loop жив — BullMQ не
 * детектит stall). timeout у child_process по умолчанию останавливает
 * процесс мягким сигналом.
 */
export function execWithTimeout(
  file: string,
  args: string[],
  timeoutMs: number,
  maxBuffer = 64 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { maxBuffer, timeout: timeoutMs },
      (error, stdout, stderr) => {
        activeChildProcesses.delete(child);
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    activeChildProcesses.add(child);
  });
}

/**
 * Остановить все активные дочерние процессы: каждому посылаем мягкий
 * сигнал завершения, через hardAfterMs — принудительный. Нужно, чтобы
 * shutdown воркера не ждал часовой encode: процесс завершается, джоба
 * быстро отдаёт ошибку, worker.close() отпускает слот.
 */
export function stopActiveChildren(hardAfterMs = 5_000): Promise<void> {
  const isAlive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
  const live = [...activeChildProcesses].filter(isAlive);
  if (live.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve();
    };

    for (const child of live) {
      child.kill("SIGTERM");
      // Мягкий сигнал сработал — принудительный уже незачем.
      child.once("exit", () => {
        if ([...activeChildProcesses].every((c) => !isAlive(c))) finish();
      });
    }

    const hardTimer = setTimeout(() => {
      for (const child of live) {
        if (isAlive(child)) child.kill("SIGKILL");
      }
      finish();
    }, hardAfterMs);
  });
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
  const handler = tags?.handler_name?.trim();
  // ffmpeg пишет в mp4 дефолтные «SoundHandler»/«VideoHandler»/«SubtitleHandler» —
  // это не имя озвучки, а мусор, который иначе уезжал в authorTitle.
  const meaningfulHandler =
    handler && !/^(sound|video|subtitle|text)handler$/i.test(handler) ? handler : undefined;
  return tags?.title ?? tags?.name ?? meaningfulHandler ?? null;
}

/** ffprobe → типизированная карточка медиафайла. */
export async function probeMedia(
  filePath: string,
  cfg: FfmpegConfig = {},
  /** Доп. аргументы перед входом (например, -protocol_whitelist для URL). */
  inputArgs: string[] = [],
): Promise<SourceInfo> {
  const ffprobe = cfg.ffprobePath ?? "ffprobe";
  const { stdout } = await execWithTimeout(
    ffprobe,
    [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
      ...inputArgs,
      filePath,
    ],
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
