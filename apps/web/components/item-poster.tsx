"use client";

import type { ItemSummary } from "@zal/api-client";
import { decode } from "blurhash";
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { ownPoster } from "@/lib/images";

/** Blurhash → крошечный canvas, растянутый CSS-ом: плейсхолдер без сети. */
function BlurhashCanvas({ hash, className }: { hash: string; className?: string }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    try {
      const pixels = decode(hash, 32, 48);
      const data = ctx.createImageData(32, 48);
      data.data.set(pixels);
      ctx.putImageData(data, 0, 0);
    } catch {
      // битый хеш — остаётся фон доминантного цвета
    }
  }, [hash]);
  return <canvas ref={ref} width={32} height={48} className={className} />;
}

/**
 * Постер тайтла: свои AVIF/WebP (srcset по ширинам) поверх blurhash и
 * доминантного цвета (у старых карточек без нарезок — как раньше); файлов нет или они не загрузились — PosterImage
 * (next/image или <img>), как раньше. Родитель — relative с aspect-[2/3].
 */
export function ItemPoster({
  item,
  fallbackSrc,
  alt,
  className,
  sizes,
  priority = false,
  onError,
  fill = true,
  width,
  height,
}: {
  item: Pick<ItemSummary, "images">;
  fallbackSrc: string | null;
  alt: string;
  className?: string;
  sizes: string;
  priority?: boolean;
  onError?: () => void;
  fill?: boolean;
  width?: number;
  height?: number;
}) {
  const own = ownPoster(item);
  const [ownFailed, setOwnFailed] = React.useState(false);

  if (!own || ownFailed) {
    return (
      <PosterImage
        src={fallbackSrc}
        alt={alt}
        className={className}
        sizes={sizes}
        priority={priority}
        onError={onError}
        fill={fill}
        width={width}
        height={height}
      />
    );
  }
  // Плейсхолдер всегда под картинкой (картинка позиционирована и идёт
  // позже в DOM): пока она грузится — виден blurhash, загрузилась — закрыла.
  // Без состояния «loaded»: onLoad до гидрации теряется, и плейсхолдер
  // навсегда закрыл бы закэшированную картинку.
  const pos = fill ? "absolute inset-0 h-full w-full" : "relative";
  return (
    <>
      <span
        aria-hidden="true"
        className="absolute inset-0"
        style={{ backgroundColor: own.color ?? undefined }}
        data-testid="poster-placeholder"
      >
        {own.blurhash && <BlurhashCanvas hash={own.blurhash} className="h-full w-full" />}
      </span>
      <picture>
        <source type="image/avif" srcSet={own.avif} sizes={sizes} />
        <source type="image/webp" srcSet={own.webp} sizes={sizes} />
        <img
          src={own.src}
          alt={alt}
          className={`${pos} ${className ?? ""}`.trim()}
          width={width}
          height={height}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          decoding="async"
          onError={() => setOwnFailed(true)}
          data-testid="own-poster"
        />
      </picture>
    </>
  );
}
