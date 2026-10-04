"use client";

import type { ItemSummary } from "@zal/api-client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { BackdropCard } from "./backdrop-card";
import { FavoritesProvider } from "./favorites-batch";
import { ItemCard } from "./item-card";

/**
 * Горизонтальная лента: snap-прокрутка, стрелки на десктопе, один
 * батч-запрос закладок на все карточки. `ranked` — «Топ-10» с большими
 * цифрами слева от постера, `landscape` — широкие 16:9 карточки-бэкдропы.
 */
export function ItemRail({
  title,
  items,
  href,
  ranked = false,
  landscape = false,
}: {
  title: string;
  items: ItemSummary[];
  href?: string;
  ranked?: boolean;
  landscape?: boolean;
}) {
  const ids = React.useMemo(() => items.map((i) => i.id), [items]);
  const scroller = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ start: true, end: false });

  const updateEdges = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    });
  }, []);
  React.useEffect(() => {
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [updateEdges]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  if (items.length === 0) return null;

  return (
    <section className="group/rail relative mb-10" data-testid="item-rail">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        {href && (
          <a href={href} className="text-sm text-muted transition hover:text-white">
            Всё →
          </a>
        )}
      </div>
      <FavoritesProvider itemIds={ids}>
        <div
          ref={scroller}
          onScroll={updateEdges}
          className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item, i) =>
            landscape ? (
              <BackdropCard key={item.id} item={item} className="w-72 shrink-0 snap-start sm:w-80" />
            ) : ranked ? (
              <div key={item.id} className="flex shrink-0 snap-start items-end">
                <span
                  aria-hidden
                  className="-mr-3 select-none text-[7rem] font-black leading-[0.8] tracking-tighter text-transparent [-webkit-text-stroke:2px_rgba(255,255,255,0.35)] sm:text-[9rem]"
                >
                  {i + 1}
                </span>
                <ItemCard item={item} className="w-36 sm:w-44" />
              </div>
            ) : (
              <ItemCard key={item.id} item={item} className="w-40 shrink-0 snap-start sm:w-48" />
            ),
          )}
        </div>
      </FavoritesProvider>
      {!edges.start && (
        <button
          type="button"
          aria-label="Назад"
          onClick={() => scrollBy(-1)}
          className="absolute left-0 top-1/2 z-20 hidden h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white opacity-0 backdrop-blur transition hover:bg-black/90 group-hover/rail:opacity-100 md:flex"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}
      {!edges.end && (
        <button
          type="button"
          aria-label="Вперёд"
          onClick={() => scrollBy(1)}
          className="absolute right-0 top-1/2 z-20 hidden h-12 w-12 translate-x-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white opacity-0 backdrop-blur transition hover:bg-black/90 group-hover/rail:opacity-100 md:flex"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
    </section>
  );
}
