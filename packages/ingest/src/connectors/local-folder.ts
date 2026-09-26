/**
 * LocalFolder: папка с твоими файлами. Ищет видеофайлы, подхватывает
 * субтитры-призраки рядом (та же база имени), тянет без копирования.
 */
import { readdir, stat } from "node:fs/promises";
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

const VIDEO_EXT = new Set([".mkv", ".mp4", ".mov", ".avi", ".webm", ".m4v"]);
const SUB_EXT = new Set([".srt", ".ass", ".ssa", ".vtt"]);

export class LocalFolderConnector implements SourceConnector {
  readonly kind = "local" as const;

  constructor(
    private readonly root: string,
    private readonly cfg: FfmpegConfig = {},
  ) {}

  /** ref обязан лежать внутри root — защита от path traversal. */
  private resolve(ref: string): string {
    const abs = path.resolve(this.root, ref);
    const rootAbs = path.resolve(this.root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new Error(`local source: ref escapes root: ${ref}`);
    }
    return abs;
  }

  async search(query: SourceQuery): Promise<SourceEntry[]> {
    const out: SourceEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!VIDEO_EXT.has(ext)) continue;
        const title = path.basename(e.name, ext);
        if (query.title && !title.toLowerCase().includes(query.title.toLowerCase())) continue;
        out.push({
          ref: path.relative(this.root, p),
          title,
          subtitleRefs: (await this.sidecars(p)).map((s) => path.relative(this.root, s)),
        });
        if (query.limit && out.length >= query.limit) return;
      }
    };
    await walk(path.resolve(this.root));
    return out;
  }

  async probe(ref: string): Promise<SourceInfo> {
    return probeMedia(this.resolve(ref), this.cfg);
  }

  async pull(ref: string, opts: PullOptions): Promise<PulledSource> {
    const abs = this.resolve(ref);
    await stat(abs); // убедились, что файл есть
    const sidecars = await this.sidecars(abs);
    const refs = opts.subtitleRefs?.length
      ? opts.subtitleRefs.map((r) => this.resolve(r))
      : sidecars;
    return {
      filePath: abs,
      subtitlePaths: refs.map((p) => ({ path: p, lang: null })),
      cleanup: async () => {},
    };
  }

  private async sidecars(filePath: string): Promise<string[]> {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SUB_EXT.has(ext)) continue;
      if (path.basename(e.name, ext) === base) out.push(path.join(dir, e.name));
    }
    return out.sort();
  }
}
