"use client";

/**
 * Батч закладок для лент: один getFavoritesBatch на рельсу вместо N
 * getFavorite на карточку. FavoriteButton вне провайдера (страница
 * тайтла) работает как раньше — одиночным запросом.
 */
import * as React from "react";
import { useOptionalAuth } from "@/lib/auth";

interface FavoritesBatch {
  /** false — батч ещё в полёте, кнопка ждёт и не стреляет своим запросом. */
  ready: boolean;
  has: (itemId: number) => boolean;
}

const Ctx = React.createContext<FavoritesBatch | null>(null);

export function FavoritesProvider({
  itemIds,
  children,
}: {
  itemIds: number[];
  children: React.ReactNode;
}) {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;
  const [ids, setIds] = React.useState<Set<number> | null>(null);

  // Гость — сразу «пусто и готово», без запроса.
  React.useEffect(() => {
    if (!api || !user) {
      setIds(new Set());
      return;
    }
    if (itemIds.length === 0) {
      setIds(new Set());
      return;
    }
    let cancelled = false;
    api
      .getFavoritesBatch(itemIds)
      .then((res) => {
        if (!cancelled) setIds(new Set(res.favorites));
      })
      .catch(() => {
        // Батч упал — не блокируем кнопки навсегда: отдаём пусто, кнопка
        // покажет «Сохранить», тумблер сам скорректирует по факту клика.
        if (!cancelled) setIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [api, user, itemIds]);

  const value = React.useMemo<FavoritesBatch>(
    () => ({ ready: ids !== null, has: (id: number) => ids?.has(id) ?? false }),
    [ids],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** null — вне провайдера; тогда кнопка резолвит себя сама. */
export function useFavoritesBatch(): FavoritesBatch | null {
  return React.useContext(Ctx);
}
