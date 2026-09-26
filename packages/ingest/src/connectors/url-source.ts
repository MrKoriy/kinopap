/**
 * UrlSource: прямая ссылка на файл. Скачивает в рабочую папку,
 * probe умеет и по URL (ffprobe поддерживает http).
 * У ссылки нет каталога — search возвращает пусто; плагины с
 * реальными источниками реализуют search сами.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { probeMedia, type FfmpegConfig } from "../media/probe";
import type {
  PulledSource,
  PullOptions,
  SourceConnector,
  SourceEntry,
  SourceInfo,
  SourceQuery,
} from "../types";

export class UrlSourceConnector implements SourceConnector {
  readonly kind = "url" as const;

  constructor(
    private readonly cfg: FfmpegConfig & { fetch?: typeof fetch } = {},
  ) {}

  async search(_query: SourceQuery): Promise<SourceEntry[]> {
    return [];
  }

  async probe(ref: string): Promise<SourceInfo> {
    return probeMedia(ref, this.cfg);
  }

  async pull(ref: string, opts: PullOptions): Promise<PulledSource> {
    const doFetch = this.cfg.fetch ?? fetch;
    const filePath = await download(doFetch, ref, opts.workDir);
    const subtitlePaths = [];
    for (const sub of opts.subtitleRefs ?? []) {
      subtitlePaths.push({
        path: await download(doFetch, sub, opts.workDir),
        lang: null,
      });
    }
    return { filePath, subtitlePaths, cleanup: async () => {} };
  }
}

async function download(
  doFetch: typeof fetch,
  url: string,
  workDir: string,
): Promise<string> {
  let name: string;
  try {
    name = path.basename(new URL(url).pathname) || "source.bin";
  } catch {
    throw new Error(`url source: not a valid URL: ${url}`);
  }
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`url source: HTTP ${res.status} for ${url}`);
  const filePath = path.join(workDir, name);
  await writeFile(filePath, Buffer.from(await res.arrayBuffer()));
  return filePath;
}
