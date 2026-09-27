"use client";

import type { ItemSummary } from "@zal/api-client";
import { cn } from "@zal/ui";
import { Film } from "lucide-react";
import Link from "next/link";
/** Карточка тайтла: постер, hover-оверлей с инфо и переходом к просмотру. */
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/format";

export function ItemCard({
  item,
  className,
}: {
  item: ItemSummary;
  className?: string;
}) {
  const [imgError, setImgError] = React.useState(false);
  const poster = !imgError ? (item.posters.medium ?? item.posters.small ?? item.posters.big) : null;
  const rating = item.rating > 0 ? item.rating : item.imdb.rating;

  return (
    <Link
      href={`/item/${item.id}`}
      className={cn(
        "group relative block w-full overflow-hidden rounded-[var(--radius-card)]",
        className,
      )}
      data-testid="item-card"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface-2">
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
      </div>

      {rating !== null && rating > 0 && (
        <Badge className="absolute left-2 top-2 bg-black/70 text-white">
          {rating.toFixed(1)}
        </Badge>
      )}

      {/* Оверлей — чистый CSS-hover: motion тут дублировал group-hover. */}
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/95 via-black/70 to-transparent p-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        <p className="text-sm font-semibold leading-tight text-white">{item.title}</p>
        <p className="mt-1 text-xs text-white/70">
          {[item.year, item.duration.average ? formatDuration(item.duration.average) : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="mt-0.5 line-clamp-1 text-xs text-white/60">
          {item.genres.map((g) => g.title).join(", ")}
        </p>
        <span className="mt-2 w-fit rounded-full bg-accent px-3 py-1 text-xs font-semibold text-white">
          Смотреть
        </span>
      </div>
    </Link>
  );
}
