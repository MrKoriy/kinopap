"use client";

import { ITEM_TYPE_TITLES, type ItemSummary } from "@zal/api-client";
import { cn } from "@zal/ui";
import { Film, Play } from "lucide-react";
import Link from "next/link";
/** Карточка тайтла: постер, hover-оверлей, закладка и бейдж типа. */
import * as React from "react";
import { FavoriteButton } from "@/components/favorite-button";
import { ItemHoverPreview, useHoverPreview } from "@/components/item-hover-preview";
import { PosterImage } from "@/components/poster-image";
import { Badge } from "@/components/ui/badge";
import { displayRating, formatDurationHuman } from "@/lib/format";

/**
 * Бейдж типа показываем только там, где он различает контент в сетке
 * (сериал/аниме/док-сериал/ТВ-шоу). У фильмов бейдж был бы шумом.
 */
const TYPED_BADGE: ReadonlySet<ItemSummary["type"]> = new Set([
  "serial",
  "anime",
  "docuserial",
  "tvshow",
]);

export function ItemCard({
  item,
  className,
  progress,
}: {
  item: ItemSummary;
  className?: string;
  /** Доля просмотра 0..1 — тонкая полоса внизу постера (история/резюме). */
  progress?: number;
}) {
  const [imgError, setImgError] = React.useState(false);
  const preview = useHoverPreview();
  const poster = !imgError ? (item.posters.medium ?? item.posters.small ?? item.posters.big) : null;
  const rating = displayRating(item);
  const typeTitle = TYPED_BADGE.has(item.type) ? ITEM_TYPE_TITLES[item.type] : null;
  const progressRatio =
    progress != null ? Math.min(1, Math.max(0, progress)) : null;

  return (
    // Закладка — сосед ссылки, а не вложенный в неё элемент: <a> внутри <a>
    // ломает разметку и всплытие кликов.
    // biome-ignore lint/a11y/noStaticElementInteractions: hover лишь открывает превью — те же действия доступны ссылкой карточки
    <div
      className={cn("group relative w-full", className)}
      onMouseEnter={(e) => preview.onEnter(e.currentTarget)}
      onMouseLeave={preview.onLeave}
    >
      <Link
        href={`/item/${item.id}`}
        className="block w-full"
        data-testid="item-card"
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius-card)] bg-surface-2 ring-1 ring-white/5 transition group-hover:ring-white/20">
          {poster ? (
            <PosterImage
              src={poster}
              alt={item.title}
              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 16vw"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center bg-gradient-to-br from-neutral-800 to-neutral-950 p-4 text-center">
              <Film className="mb-2 h-8 w-8 text-white/30" />
              <span className="line-clamp-2 text-sm font-semibold text-white/90">
                {item.title}
              </span>
              {item.year && (
                <span className="mt-1 text-xs text-white/50">{item.year}</span>
              )}
            </div>
          )}

          {rating !== null && rating > 0 && (
            <Badge
              className={cn(
                "absolute left-2 top-2 border-transparent font-semibold tabular-nums text-white backdrop-blur-sm",
                rating >= 7 ? "bg-emerald-600/90" : rating >= 5 ? "bg-amber-600/90" : "bg-black/70",
              )}
            >
              {rating.toFixed(1)}
            </Badge>
          )}

          {progressRatio != null && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div
                className="h-full bg-accent"
                style={{ width: `${progressRatio * 100}%` }}
                data-testid="item-card-progress"
              />
            </div>
          )}

          {/* Оверлей — чистый CSS-hover: motion тут дублировал group-hover. */}
          <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/95 via-black/60 to-transparent p-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <span className="absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 scale-90 items-center justify-center rounded-full bg-accent/90 text-white shadow-lg transition duration-300 group-hover:scale-100">
              <Play className="ml-0.5 h-5 w-5 fill-current" />
            </span>
            <p className="text-xs text-white/80">
              {[item.year, item.duration.average ? formatDurationHuman(item.duration.average) : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mt-0.5 line-clamp-2 text-xs text-white/60">
              {item.genres.map((g) => g.title).join(", ")}
            </p>
          </div>
        </div>
        {/* Подпись под постером: на тач-экранах hover нет, и без неё сетка —
            стена картинок без названий. */}
        <div className="px-0.5 pt-2">
          <p className="line-clamp-1 text-sm font-medium leading-tight text-white/90 group-hover:text-white">
            {item.title}
          </p>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted">
            {[item.year, typeTitle].filter(Boolean).join(" · ") || "\u00a0"}
          </p>
        </div>
      </Link>

      <FavoriteButton itemId={item.id} variant="icon" className="absolute right-2 top-2 z-10" />
      {preview.rect && (
        <ItemHoverPreview
          item={item}
          rect={preview.rect}
          onKeep={preview.keep}
          onLeave={preview.onLeave}
          onTrailerOpen={preview.setTrailerOpen}
        />
      )}
    </div>
  );
}
