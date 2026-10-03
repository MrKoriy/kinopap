"use client";

/**
 * Превью карточки при наведении (как у стримингов): через ~0,5 с над
 * карточкой раскрывается панель — кадр, название, год/тип/длительность,
 * рейтинг, жанры, описание, «Смотреть» и «Трейлер». Только для мыши
 * (hover: hover) — на тач-экранах карточка ведёт себя как раньше.
 *
 * Панель рендерится порталом в body с position: fixed — ленты с
 * overflow-x обрезали бы её. Скролл закрывает превью (координаты устарели).
 */
import { ITEM_TYPE_TITLES, type ItemSummary } from "@zal/api-client";
import { Play } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { createPortal } from "react-dom";
import { PosterImage } from "@/components/poster-image";
import { TrailerButton } from "@/components/trailer-button";
import { displayRating, formatDurationHuman } from "@/lib/format";

const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 120;

export function useHoverPreview() {
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const [pinned, setPinned] = React.useState(false);
  const openTimer = React.useRef<number | null>(null);
  const closeTimer = React.useRef<number | null>(null);
  const pinnedRef = React.useRef(false);
  pinnedRef.current = pinned;


  const onEnter = React.useCallback((el: HTMLElement) => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (openTimer.current) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setRect(el.getBoundingClientRect());
    }, OPEN_DELAY_MS);
  }, []);

  const onLeave = React.useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = null;
    if (pinnedRef.current) return;
    closeTimer.current = window.setTimeout(() => setRect(null), CLOSE_DELAY_MS);
  }, []);

  const keep = React.useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  React.useEffect(() => {
    if (!rect) return;
    const close = () => {
      if (!pinnedRef.current) setRect(null);
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [rect]);

  React.useEffect(
    () => () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const setTrailerOpen = React.useCallback((open: boolean) => {
    setPinned(open);
    if (!open) setRect(null);
  }, []);

  return { rect, onEnter, onLeave, keep, setTrailerOpen };
}

/** Позиция панели: по центру карточки, в пределах окна. */
export function previewPosition(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; width: number } {
  const width = Math.min(380, Math.max(300, rect.width * 1.6));
  const height = (width * 9) / 16 + 200;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), viewport.width - width - 8);
  const top = Math.min(Math.max(8, rect.top - 24), Math.max(8, viewport.height - height - 8));
  return { left, top, width };
}

export function ItemHoverPreview({
  item,
  rect,
  onKeep,
  onLeave,
  onTrailerOpen,
}: {
  item: ItemSummary;
  rect: DOMRect;
  onKeep: () => void;
  onLeave: () => void;
  onTrailerOpen: (open: boolean) => void;
}) {
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const id = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const pos = previewPosition(rect, { width: window.innerWidth, height: window.innerHeight });
  const image = item.posters.big ?? item.posters.medium ?? item.posters.small;
  const rating = displayRating(item);
  const meta = [
    item.year,
    ITEM_TYPE_TITLES[item.type],
    item.duration.average ? formatDurationHuman(item.duration.average) : null,
  ].filter(Boolean);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: hover держит превью открытым, действия — обычные ссылки/кнопки внутри
    <div
      className={`fixed z-[60] overflow-hidden rounded-xl border border-white/10 bg-surface shadow-2xl shadow-black/70 transition duration-200 ease-out ${
        shown ? "scale-100 opacity-100" : "scale-95 opacity-0"
      }`}
      style={{ left: pos.left, top: pos.top, width: pos.width }}
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
      data-testid="item-hover-preview"
    >
      <Link href={`/item/${item.id}`} className="relative block aspect-video w-full overflow-hidden bg-surface-2">
        {image && (
          <PosterImage
            src={image}
            alt=""
            fill
            sizes="380px"
            className="object-cover object-[50%_20%]"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/20 to-transparent" />
        <p className="absolute inset-x-4 bottom-2 line-clamp-2 text-lg font-bold leading-tight text-white drop-shadow">
          {item.title}
        </p>
      </Link>
      <div className="space-y-2 px-4 pb-4 pt-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/70">
          {rating != null && rating > 0 && (
            <span className={`font-semibold ${rating >= 7 ? "text-emerald-400" : rating >= 5 ? "text-amber-400" : "text-white/60"}`}>
              ★ {rating.toFixed(1)}
            </span>
          )}
          {meta.map((m) => (
            <span key={String(m)}>{m}</span>
          ))}
        </div>
        {item.genres.length > 0 && (
          <p className="line-clamp-1 text-xs text-muted">{item.genres.map((g) => g.title).join(" · ")}</p>
        )}
        {item.plot && <p className="line-clamp-3 text-xs leading-relaxed text-white/70">{item.plot}</p>}
        <div className="flex items-center gap-2 pt-1">
          <Link
            href={`/item/${item.id}`}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover"
            data-testid="hover-preview-watch"
          >
            <Play className="h-4 w-4 fill-current" /> Смотреть
          </Link>
          <TrailerButton
            trailer={item.trailer}
            title={item.title}
            onOpenChange={onTrailerOpen}
            className="inline-flex items-center rounded-full bg-white/10 px-4 py-2 text-sm text-white transition hover:bg-white/20"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
