"use client";

/** Широкая 16:9 карточка (бэкдроп) для части рядов главной. */
import { ITEM_TYPE_TITLES, type ItemSummary } from "@zal/api-client";
import { cn } from "@zal/ui";
import { Play } from "lucide-react";
import Link from "next/link";
import { PosterImage } from "@/components/poster-image";
import { displayRating, formatDurationHuman } from "@/lib/format";
import { backdropFor } from "@/lib/images";
import { useStreamPrefetch } from "@/lib/stream-prefetch";

export function BackdropCard({ item, className }: { item: ItemSummary; className?: string }) {
  const prefetch = useStreamPrefetch(item.id);
  const { src, isPoster } = backdropFor(item);
  const rating = displayRating(item);
  const meta = [
    item.year,
    ITEM_TYPE_TITLES[item.type],
    item.duration.average ? formatDurationHuman(item.duration.average) : null,
  ].filter(Boolean);
  return (
    <Link
      href={`/item/${item.id}`}
      className={cn(
        "group relative block aspect-video overflow-hidden rounded-[var(--radius-card)] bg-surface-2 ring-1 ring-white/5 transition hover:ring-white/20",
        className,
      )}
      onMouseEnter={prefetch.intent}
      onMouseLeave={prefetch.cancel}
      onFocus={prefetch.intent}
      onBlur={prefetch.cancel}
      data-testid="item-card-wide"
    >
      <PosterImage
        src={src}
        alt={item.title}
        className={cn(
          "h-full w-full object-cover transition duration-500 group-hover:scale-105",
          isPoster && "object-[50%_25%]",
        )}
        sizes="(max-width: 640px) 80vw, 360px"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
      <span className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-accent/90 text-white opacity-0 shadow-lg transition group-hover:opacity-100">
        <Play className="ml-0.5 h-4 w-4 fill-current" />
      </span>
      <div className="absolute inset-x-3 bottom-2.5">
        <p className="line-clamp-1 text-sm font-semibold text-white drop-shadow">{item.title}</p>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-white/70">
          {rating != null && rating > 0 && (
            <span className={rating >= 7 ? "font-semibold text-emerald-400" : "font-semibold text-amber-400"}>
              ★ {rating.toFixed(1)}
            </span>
          )}
          <span className="line-clamp-1">{meta.join(" · ")}</span>
        </p>
      </div>
    </Link>
  );
}
