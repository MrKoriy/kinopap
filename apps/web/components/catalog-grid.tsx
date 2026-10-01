"use client";

import type { ItemSummary } from "@zal/api-client";
import * as React from "react";
import { ItemCard } from "@/components/item-card";
import { type CatalogParams, fetchItems } from "@/lib/api";

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

  // При смене фильтров — сбрасываем.
  React.useEffect(() => {
    setItems(initialItems);
    setCursor(initialCursor);
  }, [initialItems, initialCursor]);

  const loadMore = React.useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchItems({ ...baseParams, cursor });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      // Обновляем URL, чтобы «Поделиться» указывал на текущую глубину.
      const qs = new URLSearchParams(
        Object.entries({ ...baseParams, cursor: page.nextCursor ?? "" }).filter(
          ([, v]) => v !== undefined && v !== "",
        ) as [string, string][],
      );
      window.history.replaceState(null, "", `/catalog${qs.size ? `?${qs.toString()}` : ""}`);
    } catch {
      // Тихо: пользователь нажмёт «Показать ещё» повторно.
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, baseParams]);

  return (
    <>
      <div
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
        data-testid="catalog-grid"
      >
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </div>
      {cursor && (
        <div className="mt-10 flex justify-center">
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
