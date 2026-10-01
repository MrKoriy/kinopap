import { allowedImageHosts, parseExtraImageHosts } from "@zal/shared/image-hosts";
import Image from "next/image";

/**
 * Постеры: next/image для известных хостов, обычный <img> для остальных.
 * Список хостов — единый с next.config (через @zal/shared/image-hosts).
 */
const ALLOWED_HOSTS = allowedImageHosts(parseExtraImageHosts());

export function isOptimizableImageSrc(src: string): boolean {
  try {
    const u = new URL(src);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      ALLOWED_HOSTS.has(u.host)
    );
  } catch {
    return false;
  }
}

export interface PosterImageProps {
  src: string | null | undefined;
  alt: string;
  /** CSS-классы — что до <img>, что до next/image. */
  className?: string;
  /** sizes для next/image (например "(max-width: 640px) 50vw, 300px"). */
  sizes?: string;
  priority?: boolean;
  /** fill=true требует position:relative у родителя. */
  fill?: boolean;
  width?: number;
  height?: number;
  /** Битый URL (404 на чужом CDN) — карточка покажет заглушку. */
  onError?: () => void;
}

export function PosterImage({
  src,
  alt,
  className,
  sizes = "(max-width: 640px) 50vw, 16vw",
  priority = false,
  fill = true,
  width,
  height,
  onError,
}: PosterImageProps) {
  if (!src) return null;
  if (isOptimizableImageSrc(src)) {
    if (fill) {
      return (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          className={className}
          onError={onError}
        />
      );
    }
    return (
      <Image
        src={src}
        alt={alt}
        width={width ?? 320}
        height={height ?? 480}
        sizes={sizes}
        priority={priority}
        className={className}
        onError={onError}
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      width={width}
      height={height}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      onError={onError}
    />
  );
}
