"use client";

import type { ItemSummary } from "@zal/api-client";
import * as React from "react";
import { ItemCard } from "@/components/item-card";
import { type CatalogParams, fetchItems } from "@/lib/api";

/** Сколько карточек максимум держим в sessionStorage для «Назад». */
const RESTORE_MAX = 600;

// «Назад/Вперёд» внутри SPA: роутер Next перерисовывает страницу после
// popstate — флаг говорит сетке, что можно вернуть глубину и прокрутку.
let poppedAt = 0;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    poppedAt = Date.now();
  });
}

function isBackNavigation(): boolean {
  if (Date.now() - poppedAt < 3000) return true;
  const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === "back_forward";
}

interface Snapshot {
  items: ItemSummary[];
  cursor: string | null;
  y: number;
}

const storageKey = (params: Omit<CatalogParams, "cursor">) => `catalog:${JSON.stringify(params)}`;

function readSnapshot(key: string): Snapshot | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

function writeSnapshot(key: string, snap: Snapshot): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...snap, items: snap.items.slice(0, RESTORE_MAX) }));
  } catch {
    // квота/приватный режим — без восстановления
  }
}

export function CatalogGrid({
  initialItems,
  initialCursor,
  baseParams,
}: {
  initialItems: ItemSummary[];
  initialCursor: string | null;
  baseParams: Omit<CatalogParams, "cursor">;
}) {
  const [items, setItems] = React.useState(initialItems);
  const [cursor, setCursor] = React.useState(initialCursor);
  const [loading, setLoading] = React.useState(false);
  const key = storageKey(baseParams);
  const stateRef = React.useRef({ items, cursor });
  stateRef.current = { items, cursor };

  // При смене фильтров — сбрасываем; при «Назад» — возвращаем подгруженную
  // глубину и позицию прокрутки (раньше возврат начинал сетку с начала).
  React.useEffect(() => {
    const snap = isBackNavigation() ? readSnapshot(key) : null;
    if (snap && snap.items.length > initialItems.length && snap.items[0]?.id === initialItems[0]?.id) {
      setItems(snap.items);
      setCursor(snap.cursor);
      const y = snap.y;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.scrollTo(0, y)));
    } else {
      setItems(initialItems);
      setCursor(initialCursor);
    }
  }, [initialItems, initialCursor, key]);

  // Снимок при уходе со страницы и по ходу прокрутки (дёшево, раз в 400 мс).
  React.useEffect(() => {
    let t: number | null = null;
    const save = () => writeSnapshot(key, { ...stateRef.current, y: window.scrollY });
    const onScroll = () => {
      if (t) return;
      t = window.setTimeout(() => {
        t = null;
        save();
      }, 400);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      if (t) window.clearTimeout(t);
      save();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
    };
  }, [key]);

  const loadMore = React.useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchItems({ ...baseParams, cursor });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      // Тихо: пользователь нажмёт «Показать ещё» повторно.
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, baseParams]);

  // Бесконечная прокрутка: следующая страница грузится заранее, за ~1.5
  // экрана до конца сетки. Кнопка «Показать ещё» остаётся запасным путём.
  const sentinel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  return (
    <>
      <div
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
        data-testid="catalog-grid"
      >
        {items.map((item, i) => (
          // Карточки за пределами первых экранов браузер не рендерит, пока
          // они не близко к вьюпорту (content-visibility) — дешёвая виртуализация.
          <ItemCard key={item.id} item={item} className={i >= 24 ? "cv-auto" : undefined} />
        ))}
      </div>
      {cursor && (
        <div ref={sentinel} className="mt-10 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="rounded-full border border-border px-6 py-2.5 text-sm font-medium text-white transition hover:bg-surface-2 disabled:opacity-50"
            data-testid="load-more"
          >
            {loading ? "Загрузка…" : "Показать ещё"}
          </button>
        </div>
      )}
      {!cursor && items.length === 0 && (
        <p className="py-16 text-center text-muted" data-testid="catalog-empty">
          Ничего не найдено.
        </p>
      )}
    </>
  );
}
