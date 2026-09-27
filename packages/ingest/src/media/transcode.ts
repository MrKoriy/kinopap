/**
 * Транскод в multi-audio HLS: видео-лестница качеств + отдельные
 * аудио-рендitions (дубляжи) + мастер-плейлист с audio groups.
 * Один проход ffmpeg через -var_stream_map/agroup: видео-варианты
 * ссылаются на общую группу аудио, переключение дубляжа — на лету.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { probeMedia, type FfmpegConfig } from "./probe";
import { selectLadder, type Rung } from "./ladder";

const execFileAsync = promisify(execFile);

export interface AudioRenditionInput {
  lang: string | null;
  title: string | null;
}

export interface TranscodedRung {
  quality: string;
  qualityId: number;
  width: number;
  height: number;
  videoBitrateKbps: number;
  dirName: string;
  playlistPath: string;
  segmentPaths: string[];
}

export interface TranscodedAudioRendition {
  index: number;
  dirName: string;
  playlistPath: string;
  /** Персональный мастер этого дубляжа (видео-лестница + одна аудио-группа). */
  masterPlaylistPath: string | null;
  segmentPaths: string[];
}

export interface TranscodeResult {
  /** Мастер-плейлист: EXT-X-STREAM-INF (видео) + EXT-X-MEDIA (аудио-группа). */
  masterPlaylistPath: string;
  rungs: TranscodedRung[];
  audioRenditions: TranscodedAudioRendition[];
}

export interface TranscodeOptions extends FfmpegConfig {
  ladder?: readonly string[];
}

function safeToken(raw: string | null | undefined, fallback: string): string {
  const t = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return t || fallback;
}

/** Имя папки аудио-рендitions: ASCII-безопасное (кириллица ломает URL-ключи). */
export function audioRenditionName(index: number, lang: string | null): string {
  return `audio-${index}-${safeToken(lang, "und")}`;
}

/**
 * Строка -var_stream_map: каждый видео-рунт идёт своей вариацией с
 * agroup, каждая аудиодорожка — рендition той же группы (language,
 * default у первой). Без аудио — чистые видео-вариации.
 */
export function buildVarStreamMap(
  rungs: readonly Rung[],
  audios: readonly AudioRenditionInput[],
): string {
  const parts: string[] = [];
  rungs.forEach((r, i) => {
    parts.push(
      audios.length ? `v:${i},name:${r.name},agroup:aud` : `v:${i},name:${r.name}`,
    );
  });
  audios.forEach((a, i) => {
    const attrs = [`a:${i}`, `name:${audioRenditionName(i, a.lang)}`, `agroup:aud`];
    attrs.push(`language:${safeToken(a.lang, "und")}`);
    if (i === 0) attrs.push("default:yes");
    parts.push(attrs.join(","));
  });
  return parts.join(" ");
}

/**
 * Персональный мастер-плейлист дубляжа: из общего master.m3u8 оставляем
 * одну аудио-рендition (DEFAULT=YES) и все видео-варианты. Так дубляж
 * переключают плееры без API выбора аудио (нативный HLS на мобиле).
 */
export function buildDubMaster(masterContent: string, renditionName: string): string {
  const lines = masterContent.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#EXT-X-MEDIA:")) {
      // ffmpeg переименовывает NAME (audio_2, …), наши имена живут в URI.
      if (
        line.includes(`NAME="${renditionName}"`) ||
        line.includes(`URI="${renditionName}/`)
      ) {
        out.push(
          line
            .replace(/NAME="[^"]*"/, `NAME="${renditionName}"`)
            .replace(/DEFAULT=(?:YES|NO)/, "DEFAULT=YES"),
        );
      }
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const uri = lines[i + 1] ?? "";
      // Аудио-вариации (если ffmpeg вывел их отдельными стримами) пропускаем.
      if (uri.trim().startsWith("audio-")) {
        i++;
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * ffmpeg → outDir: <качество>/index.m3u8 (видео), audio-N-lang/index.m3u8
 * (аудио-рендitions), master.m3u8 (audio groups) + master-audio-N-lang.m3u8
 * (персональные мастера дубляжей). Апскейла нет.
 */
export async function transcodeToHls(
  sourcePath: string,
  outDir: string,
  sourceHeight: number,
  audios: readonly AudioRenditionInput[],
  opts: TranscodeOptions = {},
): Promise<TranscodeResult> {
  const ffmpeg = opts.ffmpegPath ?? "ffmpeg";
  const rungs = selectLadder(sourceHeight, opts.ladder);
  await mkdir(outDir, { recursive: true });

  const args = ["-y", "-i", sourcePath];
  for (const _ of rungs) args.push("-map", "0:v:0");
  audios.forEach((_, i) => args.push("-map", `0:a:${i}`));

  args.push(
    "-c:v", "libx264",
    "-preset", opts.preset ?? "veryfast",
    "-crf", String(opts.crf ?? 23),
    "-pix_fmt", "yuv420p",
  );
  rungs.forEach((r, i) => args.push(`-filter:v:${i}`, `scale=-2:${r.height}`));

  if (audios.length) {
    const audioKbps = Math.max(...rungs.map((r) => r.audioBitrateKbps));
    args.push("-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2");
  }

  args.push(
    "-var_stream_map", buildVarStreamMap(rungs, audios),
    "-master_pl_name", "master.m3u8",
    "-f", "hls",
    "-hls_time", String(opts.hlsTime ?? 4),
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(outDir, "%v", "seg_%04d.ts"),
    path.join(outDir, "%v", "index.m3u8"),
  );

  await execFileAsync(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });

  const masterPlaylistPath = path.join(outDir, "master.m3u8");

  const results: TranscodedRung[] = [];
  for (const rung of rungs) {
    const dir = path.join(outDir, rung.name);
    const segments = await listSegments(dir);
    if (!segments.length) throw new Error(`transcode: no segments for ${rung.name}`);

    // Реальные размеры выхода — из первого сегмента.
    const probed = await probeMedia(segments[0]!, opts);
    const v = probed.video[0];
    results.push({
      quality: rung.name,
      qualityId: rung.qualityId,
      width: v?.width ?? 0,
      height: v?.height ?? rung.height,
      videoBitrateKbps: rung.videoBitrateKbps,
      dirName: rung.name,
      playlistPath: path.join(dir, "index.m3u8"),
      segmentPaths: segments,
    });
  }

  const audioRenditions: TranscodedAudioRendition[] = [];
  const masterContent = audios.length
    ? await readFile(masterPlaylistPath, "utf8")
    : "";
  for (const [i, a] of audios.entries()) {
    const dirName = audioRenditionName(i, a.lang);
    const dir = path.join(outDir, dirName);
    const segments = await listSegments(dir);
    if (!segments.length) throw new Error(`transcode: no segments for ${dirName}`);

    const dubMasterPath = path.join(outDir, `master-${dirName}.m3u8`);
    await writeFile(dubMasterPath, buildDubMaster(masterContent, dirName));

    audioRenditions.push({
      index: i,
      dirName,
      playlistPath: path.join(dir, "index.m3u8"),
      masterPlaylistPath: dubMasterPath,
      segmentPaths: segments,
    });
  }

  return { masterPlaylistPath, rungs: results, audioRenditions };
}

async function listSegments(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export type { Rung };
