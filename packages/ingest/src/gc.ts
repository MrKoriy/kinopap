/**
 * GC хранилища: каталоги ingest/*, на которые не ссылается ни один ключ в
 * БД (сироты упавших прогонов, старые версии после дедупа media по
 * источнику), удаляются. Свежие каталоги (моложе graceMs) не трогаем —
 * активный ingest может быть в полёте.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@zal/db";
import { audioTracks, media, mediaFiles, subtitles } from "@zal/db";

export interface GcOptions {
  /** Каталог моложе этого не удаляем (активный ингест). */
  graceMs?: number;
}

/** Верхняя директория ключа вида `ingest/<dir>/...`. */
function topDirOfKey(key: string): string | null {
  const parts = key.split("/").filter(Boolean);
  if (parts[0] !== "ingest" || parts.length < 2) return null;
  return parts[1]!;
}

export async function gcOrphanIngestDirs(
  db: Db,
  mediaRoot: string,
  opts: GcOptions = {},
): Promise<string[]> {
  const graceMs = opts.graceMs ?? 60 * 60 * 1000;

  // Все ключи, ссылающиеся внутрь ingest/*.
  const fileRows = await db
    .select({ fileKey: mediaFiles.fileKey, hlsKey: mediaFiles.hlsKey })
    .from(mediaFiles);
  const audioRows = await db
    .select({ fileKey: audioTracks.fileKey, masterKey: audioTracks.masterKey })
    .from(audioTracks);
  const subRows = await db
    .select({ fileKey: subtitles.fileKey })
    .from(subtitles);
  const mediaRows = await db
    .select({ posterKey: media.posterKey, spriteKey: media.spriteKey })
    .from(media);

  const referenced = new Set<string>();
  for (const rows of [fileRows, audioRows, subRows, mediaRows]) {
    for (const row of rows) {
      for (const key of Object.values(row)) {
        if (key) {
          const dir = topDirOfKey(key);
          if (dir) referenced.add(dir);
        }
      }
    }
  }

  const ingestRoot = path.join(mediaRoot, "ingest");
  let entries: string[];
  try {
    entries = await readdir(ingestRoot);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (referenced.has(entry)) continue;
    const abs = path.join(ingestRoot, entry);
    try {
      const st = await stat(abs);
      if (Date.now() - st.mtimeMs < graceMs) continue;
      await rm(abs, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Недоступный каталог пропускаем — GC не должен падать.
    }
  }
  return removed;
}
