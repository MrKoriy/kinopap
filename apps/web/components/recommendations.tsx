"use client";

import type { ItemSummary } from "@zal/api-client";
/**
 * «Рекомендуем вам» на главной: персональная лента по истории профиля.
 * Клиентская — главная кэшируется ISR, а рекомендации у каждого свои.
 * Гостю и при пустой истории ничего не рисуем.
 */
import * as React from "react";
import { ItemRail } from "@/components/item-rail";
import { useOptionalAuth } from "@/lib/auth";

const MIN_ITEMS = 4;

export function Recommendations() {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const isAuthed = auth?.isAuthed ?? false;
  const [items, setItems] = React.useState<ItemSummary[]>([]);

  React.useEffect(() => {
    if (!api || !isAuthed) {
      setItems([]);
      return;
    }
    let cancelled = false;
    api.getRecommendations().then(
      (res) => {
        if (!cancelled) setItems(res.items);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, isAuthed]);

  if (items.length < MIN_ITEMS) return null;
  return (
    <div data-testid="recommendations">
      <ItemRail title="Рекомендуем вам" items={items} />
    </div>
  );
}
