/**
 * Image-пайплайн без CDN: исходник с TMDb → AVIF + WebP фиксированных ширин
 * по контент-хешу в MEDIA_ROOT/img/<2>/<hash>/<w>.<ext>. Тот же исходник —
 * тот же каталог: повторная нарезка ничего не пишет, nginx отдаёт файлы с
 * `immutable` (URL меняется только вместе с картинкой).
 *
 * Для постера дополнительно blurhash (мгновенный плейсхолдер) и доминантный
 * цвет (фон карточки и шапки тайтла).
 */
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encode } from "blurhash";
import sharp from "sharp";

/** Ширины — контракт с вебом (apps/web/lib/images.ts). */
export const POSTER_WIDTHS = [160, 320, 480] as const;
export const BACKDROP_WIDTHS = [780, 1280] as const;
export const IMAGE_FORMATS = ["avif", "webp"] as const;

export type ImageKind = "poster" | "backdrop";

export const contentHash = (buf: Buffer) => createHash("sha1").update(buf).digest("hex");

/** Каталог нарезок относительно MEDIA_ROOT — тот же, что imageDir() в @zal/db. */
export const imageRelDir = (hash: string) => join("img", hash.slice(0, 2), hash);

/**
 * Исходник нужного размера у TMDb: original постера — мегабайты, w780 хватает
 * на 480 px; бэкдроп — w1280. Чужие URL не трогаем.
 */
export function sourceUrl(url: string, kind: ImageKind): string {
  const m = url.match(/^(https:\/\/image\.tmdb\.org\/t\/p\/)[^/]+(\/.+)$/);
  if (!m) return url;
  return `${m[1]}${kind === "poster" ? "w780" : "w1280"}${m[2]}`;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Запись через временный файл: nginx никогда не отдаст недописанный AVIF. */
async function atomicWrite(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export interface ProcessedImage {
  hash: string;
  widths: number[];
  blurhash: string | null;
  color: string | null;
  written: number;
}

const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** Нарезка одного исходника. Без увеличения: маленький исходник даёт меньше ширин. */
export async function processImage(mediaRoot: string, input: Buffer, kind: ImageKind): Promise<ProcessedImage> {
  const hash = contentHash(input);
  const dir = join(mediaRoot, imageRelDir(hash));
  await mkdir(dir, { recursive: true });
  const meta = await sharp(input).metadata();
  const srcWidth = meta.width ?? 0;
  const all = kind === "poster" ? POSTER_WIDTHS : BACKDROP_WIDTHS;
  // Минимальную ширину режем всегда — даже из крохотного исходника.
  const widths = all.filter((w, i) => i === 0 || w <= srcWidth);
  let written = 0;
  for (const w of widths) {
    for (const fmt of IMAGE_FORMATS) {
      const out = join(dir, `${w}.${fmt}`);
      if (await exists(out)) continue;
      const pipeline = sharp(input).rotate().resize({ width: w, withoutEnlargement: true });
      const data =
        fmt === "avif"
          ? await pipeline.avif({ quality: 50, effort: 4 }).toBuffer()
          : await pipeline.webp({ quality: 74, effort: 4 }).toBuffer();
      await atomicWrite(out, data);
      written++;
    }
  }

  let blurhash: string | null = null;
  let color: string | null = null;
  if (kind === "poster") {
    const { data, info } = await sharp(input).resize(32, 48, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    blurhash = encode(new Uint8ClampedArray(data), info.width, info.height, 3, 4);
    const { dominant } = await sharp(input).stats();
    color = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  }
  return { hash, widths, blurhash, color, written };
}

/** Скачать исходник (с таймаутом); null — 404/сбой, тайтл просто без своих файлов. */
export async function downloadImage(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !type.startsWith("image/")) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
