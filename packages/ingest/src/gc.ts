/**
 * GC хранилища: каталоги ingest/*, на которые не ссылается ни один ключ в
 * БД (сироты упавших прогонов, старые версии после дедупа media по
 * источнику), и каталоги jobs/* (выход низкоуровневых probe/transcode
 * джоб, который нигде не хранится) удаляются. Свежие каталоги (моложе
 * graceMs) не трогаем — активный ingest может быть в полёте.
 *
 * Плюс чистка осиротевших рабочих каталогов zal-ingest-* в os.tmpdir():
 * pipeline создаёт их на каждый прогон и удаляет в finally, но краш
 * воркера оставляет мультигигабайтный мусор навсегда.
 */
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@zal/db";
import { audioTracks, media, mediaFiles, subtitles } from "@zal/db";

export interface GcOptions {
  /** Каталог моложе этого не удаляем (активный ингест). */
  graceMs?: number;
}

/** Корни хранилища, обслуживаемые GC. */
const GC_ROOTS: readonly string[] = ["ingest", "jobs"];

/** Верхняя директория ключа вида `<root>/<dir>/...`. */
function topDirOfKey(key: string): { root: string; dir: string } | null {
  const parts = key.split("/").filter(Boolean);
  const root = parts[0] ?? "";
  if (!GC_ROOTS.includes(root) || parts.length < 2) return null;
  return { root, dir: parts[1]! };
}

export async function gcOrphanIngestDirs(
  db: Db,
  mediaRoot: string,
  opts: GcOptions = {},
): Promise<string[]> {
  const graceMs = opts.graceMs ?? 60 * 60 * 1000;

  // Все ключи, ссылающиеся внутрь ingest/* (ключей в jobs/* в БД нет,
  // но проверяем оба корня на будущее).
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

  // root → множество занятых каталогов этого корня.
  const referenced = new Map<string, Set<string>>();
  for (const rows of [fileRows, audioRows, subRows, mediaRows]) {
    for (const row of rows) {
      for (const key of Object.values(row)) {
        if (key) {
          const top = topDirOfKey(key);
          if (top) {
            let dirs = referenced.get(top.root);
            if (!dirs) {
              dirs = new Set<string>();
              referenced.set(top.root, dirs);
            }
            dirs.add(top.dir);
          }
        }
      }
    }
  }

  const removed: string[] = [];
  for (const root of GC_ROOTS) {
    const rootDir = path.join(mediaRoot, root);
    let entries: string[];
    try {
      entries = await readdir(rootDir);
    } catch {
      // Нет корня — нечего чистить.
      continue;
    }

    const referencedDirs = referenced.get(root) ?? new Set<string>();
    for (const entry of entries) {
      if (referencedDirs.has(entry)) continue;
      const abs = path.join(rootDir, entry);
      try {
        const st = await stat(abs);
        if (Date.now() - st.mtimeMs < graceMs) continue;
        await rm(abs, { recursive: true, force: true });
        removed.push(`${root}/${entry}`);
      } catch {
        // Недоступный каталог пропускаем — GC не должен падать.
      }
    }
  }
  return removed;
}

export interface TmpGcOptions {
  /** Где живут рабочие каталоги (по умолчанию os.tmpdir()). */
  tmpDir?: string;
  /** Каталог старше этого удаляем. */
  maxAgeMs?: number;
}

/**
 * Рабочие каталоги zal-ingest-* старше maxAgeMs: активный ingest живёт
 * в них часами, но краш оставляет их навсегда — чистим по mtime.
 */
export async function gcStaleTmpDirs(opts: TmpGcOptions = {}): Promise<string[]> {
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(tmpDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("zal-ingest-")) continue;
    const abs = path.join(tmpDir, entry);
    try {
      const st = await stat(abs);
      if (Date.now() - st.mtimeMs < maxAgeMs) continue;
      await rm(abs, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Недоступный каталог пропускаем.
    }
  }
  return removed;
}
