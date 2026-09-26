/**
 * Транскод в HLS-лестницу (h264/aac): каждый рунг в свою папку
 * с index.m3u8 + сегментами .ts.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { probeMedia, type FfmpegConfig } from "./probe";
import { selectLadder, type Rung } from "./ladder";

const execFileAsync = promisify(execFile);

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

export interface TranscodeOptions extends FfmpegConfig {
  ladder?: readonly string[];
}

/** ffmpeg → outDir/<quality>/{index.m3u8, seg_*.ts}. */
export async function transcodeToHls(
  sourcePath: string,
  outDir: string,
  sourceHeight: number,
  opts: TranscodeOptions = {},
): Promise<TranscodedRung[]> {
  const ffmpeg = opts.ffmpegPath ?? "ffmpeg";
  const rungs = selectLadder(sourceHeight, opts.ladder);
  await mkdir(outDir, { recursive: true });

  const results: TranscodedRung[] = [];
  for (const rung of rungs) {
    const dir = path.join(outDir, rung.name);
    await mkdir(dir, { recursive: true });
    const playlist = path.join(dir, "index.m3u8");
    await execFileAsync(ffmpeg, [
      "-y",
      "-i", sourcePath,
      "-vf", `scale=-2:${rung.height}`,
      "-c:v", "libx264",
      "-preset", opts.preset ?? "veryfast",
      "-crf", String(opts.crf ?? 23),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", `${rung.audioBitrateKbps}k`,
      "-ac", "2",
      "-f", "hls",
      "-hls_time", String(opts.hlsTime ?? 4),
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", path.join(dir, "seg_%04d.ts"),
      playlist,
    ], { maxBuffer: 32 * 1024 * 1024 });

    const segments = (await readdir(dir))
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => path.join(dir, f));
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
      playlistPath: playlist,
      segmentPaths: segments,
    });
  }
  return results;
}

export type { Rung };
