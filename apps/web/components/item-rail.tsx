"use client";

import type { ItemSummary } from "@zal/api-client";
import * as React from "react";
import { FavoritesProvider } from "./favorites-batch";
import { ItemCard } from "./item-card";

/** Горизонтальная лента: один батч-запрос закладок на все карточки. */
export function ItemRail({
  title,
  items,
  href,
}: {
  title: string;
  items: ItemSummary[];
  href?: string;
}) {
  const ids = React.useMemo(() => items.map((i) => i.id), [items]);
  return (
    <section className="mb-10" data-testid="item-rail">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        {href && (
          <a href={href} className="text-sm text-muted transition hover:text-white">
            Всё →
          </a>
        )}
      </div>
      <FavoritesProvider itemIds={ids}>
        <div className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item) => (
            <ItemCard key={item.id} item={item} className="w-40 shrink-0 sm:w-48" />
          ))}
        </div>
      </FavoritesProvider>
    </section>
  );
}
