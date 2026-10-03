"use client";

/**
 * Трейлер тайтла: кнопка + модалка с плеером YouTube.
 *
 * iframe монтируется только по клику (фасад): 600 КБ JS YouTube на каждой
 * карточке — минус секунда к загрузке, а трейлер смотрит малая доля зрителей.
 * Контейнер плеера — `relative aspect-video` с явной шириной: прошлый
 * вариант с `fill` без позиционированного родителя растягивал скелетон на
 * весь экран.
 */
import { Clapperboard, ExternalLink, X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { buttonVariants } from "@/components/ui/button";

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** YouTube-id из поля trailer (id либо ссылка watch?v= / youtu.be/). */
export function youtubeId(trailer: { id: string | null; url: string | null }): string | null {
  if (trailer.id && YT_ID.test(trailer.id)) return trailer.id;
  const url = trailer.url ?? "";
  const m = /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,20})/.exec(url);
  return m?.[1] ?? null;
}

export function TrailerButton({
  trailer,
  title,
}: {
  trailer: { id: string | null; url: string | null };
  title: string;
}) {
  const id = youtubeId(trailer);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!id) return null;

  return (
    <>
      <button
        type="button"
        className={buttonVariants({ variant: "secondary" })}
        onClick={() => setOpen(true)}
        data-testid="trailer-button"
      >
        <Clapperboard className="mr-2 h-4 w-4" />
        Трейлер
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label={`Трейлер: ${title}`}
            data-testid="trailer-modal"
          >
            {/* Клик мимо плеера закрывает модалку. */}
            <button
              type="button"
              aria-label="Закрыть трейлер"
              tabIndex={-1}
              className="absolute inset-0 cursor-default"
              onClick={() => setOpen(false)}
            />
            <div className="relative z-10 w-full max-w-5xl">
              <div className="mb-2 flex items-center justify-between gap-3 text-sm text-white/80">
                <span className="truncate font-medium">{title} — трейлер</span>
                <div className="flex shrink-0 items-center gap-1">
                  <a
                    href={`https://www.youtube.com/watch?v=${id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/70 hover:bg-white/10 hover:text-white"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> YouTube
                  </a>
                  <button
                    type="button"
                    aria-label="Закрыть"
                    className="rounded-md p-1.5 hover:bg-white/10"
                    onClick={() => setOpen(false)}
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>
              <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-card)] bg-black shadow-2xl">
                <iframe
                  className="absolute inset-0 h-full w-full"
                  src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
                  title={`Трейлер: ${title}`}
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
