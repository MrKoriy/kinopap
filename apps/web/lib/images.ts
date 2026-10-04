/**
 * Свои нарезки картинок (воркер → MEDIA_ROOT/img → nginx /img, immutable).
 * Ширины — контракт с apps/worker/src/lib/images.ts.
 */
import type { ItemSummary } from "@zal/api-client";

export const POSTER_WIDTHS = [160, 320, 480] as const;
export const BACKDROP_WIDTHS = [780, 1280] as const;

/** Базовый адрес /img: пусто — тот же origin (прод за nginx). */
const IMG_BASE = (process.env.NEXT_PUBLIC_IMG_BASE_URL ?? "").replace(/\/$/, "");

export interface OwnImageSources {
  avif: string;
  webp: string;
  /** Фолбэк <img src> — средняя ширина WebP. */
  src: string;
}

export function ownImageSources(dir: string, widths: readonly number[]): OwnImageSources {
  const base = `${IMG_BASE}${dir}`;
  const set = (ext: string) => widths.map((w) => `${base}/${w}.${ext} ${w}w`).join(", ");
  const mid = widths[Math.min(1, widths.length - 1)];
  return { avif: set("avif"), webp: set("webp"), src: `${base}/${mid}.webp` };
}

/** Свой постер тайтла или null (тогда — старый путь через next/image). */
export function ownPoster(item: Pick<ItemSummary, "images">): (OwnImageSources & { blurhash: string | null; color: string | null }) | null {
  const img = item.images;
  if (!img?.poster) return null;
  return { ...ownImageSources(img.poster, POSTER_WIDTHS), blurhash: img.blurhash, color: img.color };
}

/**
 * Широкая картинка тайтла (hero, превью, 16:9-карточки): своя нарезка
 * бэкдропа → бэкдроп TMDb → постер (крупный) как последний фолбэк.
 */
export function backdropFor(
  item: Pick<ItemSummary, "images" | "backdrop" | "posters">,
): { src: string | null; isPoster: boolean } {
  const own = item.images?.backdrop;
  if (own) return { src: ownImageSources(own, BACKDROP_WIDTHS).src, isPoster: false };
  if (item.backdrop) return { src: item.backdrop, isPoster: false };
  return { src: item.posters.big ?? item.posters.medium ?? item.posters.small, isPoster: true };
}
