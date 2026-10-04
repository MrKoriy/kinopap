"use client";

/**
 * Беззвучное превью трейлера (hero, hover-карточка): YouTube без контролов,
 * 30 с с N-й секунды по кругу. Только на десктопе с мышью, без «экономии
 * трафика» и prefers-reduced-motion; выключается NEXT_PUBLIC_TRAILER_PREVIEWS=0.
 *
 * iframe прозрачен, пока YouTube не отрисует кадр (+1.2 с — прячем вспышку
 * заголовка плеера), под ним остаётся картинка. Клики проходят насквозь.
 */
import { cn } from "@zal/ui";
import * as React from "react";

const ENABLED = process.env.NEXT_PUBLIC_TRAILER_PREVIEWS !== "0";

/** Можно ли автоматически крутить превью на этом устройстве. */
export function canAutoPreview(): boolean {
  if (!ENABLED || typeof window === "undefined" || !window.matchMedia) return false;
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || conn?.effectiveType === "2g" || conn?.effectiveType === "slow-2g") return false;
  return true;
}

export function previewSrc(id: string, start = 8, length = 30): string {
  const qs = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    controls: "0",
    loop: "1",
    playlist: id,
    start: String(start),
    end: String(start + length),
    playsinline: "1",
    modestbranding: "1",
    rel: "0",
    disablekb: "1",
    iv_load_policy: "3",
    fs: "0",
  });
  return `https://www.youtube-nocookie.com/embed/${id}?${qs.toString()}`;
}

export function MutedTrailer({
  youtubeId,
  title,
  className,
  start,
}: {
  youtubeId: string;
  title: string;
  className?: string;
  start?: number;
}) {
  const [visible, setVisible] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden>
      <iframe
        // Кадр 16:9 «cover»: во всю ширину, лишняя высота уходит за края
        // (hero шире 16:9), лёгкий scale прячет кромки плеера.
        className={cn(
          "absolute left-1/2 top-1/2 aspect-video w-full -translate-x-1/2 -translate-y-1/2 scale-[1.06] border-0 transition-opacity duration-700",
          visible ? "opacity-100" : "opacity-0",
        )}
        src={previewSrc(youtubeId, start)}
        title={`Превью трейлера: ${title}`}
        tabIndex={-1}
        allow="autoplay; encrypted-media"
        loading="eager"
        onLoad={() => {
          timer.current = window.setTimeout(() => setVisible(true), 1200);
        }}
        data-testid="trailer-preview"
      />
    </div>
  );
}
