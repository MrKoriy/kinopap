"use client";

import { Bookmark, BookmarkCheck } from "lucide-react";
/**
 * Закладка «Смотреть позже». Оптимистичный UI: состояние переключается
 * мгновенно, при ошибке возвращается как было. Гость получает ссылку на вход —
 * молча ничего не делающая кнопка хуже, чем честный призыв войти.
 */
import * as React from "react";
import { useFavoritesBatch } from "@/components/favorites-batch";
import { useOptionalAuth } from "@/lib/auth";

export interface FavoriteButtonProps {
  itemId: number;
  /** "pill" — с подписью (карточка тайтла), "icon" — только иконка (постер). */
  variant?: "pill" | "icon";
  className?: string;
}

export function FavoriteButton({
  itemId,
  variant = "pill",
  className = "",
}: FavoriteButtonProps) {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;

  const [saved, setSaved] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const batch = useFavoritesBatch();

  React.useEffect(() => {
    // Внутри ленты — статус из батча (один запрос на всю рельсу).
    if (batch) {
      if (!batch.ready) return;
      setSaved(batch.has(itemId));
      setReady(true);
      return;
    }
    if (!api || !user) {
      setReady(true);
      return;
    }
    let cancelled = false;
    api.getFavorite(itemId).then(
      (res) => {
        if (cancelled) return;
        setSaved(res.favorite != null);
        setReady(true);
      },
      () => {
        if (cancelled) setReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [batch, api, user, itemId]);

  const toggle = React.useCallback(async () => {
    if (!api || busy) return;
    const was = saved;
    setSaved(!was);
    setBusy(true);
    try {
      if (was) await api.removeFavorite(itemId);
      else await api.addFavorite(itemId);
    } catch {
      setSaved(was);
    } finally {
      setBusy(false);
    }
  }, [api, busy, saved, itemId]);

  if (!user || !api) {
    if (variant === "icon") {
      return (
        <a
          href="/login"
          className={`grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80 ${className}`}
          title="Войдите, чтобы сохранить"
          data-testid="favorite-login"
        >
          <Bookmark className="h-4 w-4" />
        </a>
      );
    }
    return (
      <a
        href="/login"
        className={`inline-flex items-center rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20 ${className}`}
        data-testid="favorite-login"
      >
        <Bookmark className="mr-2 h-4 w-4" />
        Сохранить
      </a>
    );
  }

  const Icon = saved ? BookmarkCheck : Bookmark;

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={(e) => {
          // Карточка-ссылка: клик по закладке не должен открывать тайтл.
          e.preventDefault();
          e.stopPropagation();
          void toggle();
        }}
        className={`grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80 ${
          saved ? "text-accent" : ""
        } ${className}`}
        aria-pressed={saved}
        aria-label={saved ? "Убрать из сохранённого" : "Сохранить"}
        data-testid="favorite-button"
        disabled={!ready}
      >
        <Icon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      className={`inline-flex items-center rounded-lg border px-4 py-2 text-sm font-medium transition ${
        saved
          ? "border-accent bg-accent/10 text-accent hover:bg-accent/20"
          : "border-white/20 bg-white/10 text-white hover:bg-white/20"
      } ${className}`}
      aria-pressed={saved}
      data-testid="favorite-button"
      disabled={!ready}
    >
      <Icon className="mr-2 h-4 w-4" />
      {saved ? "В сохранённом" : "Сохранить"}
    </button>
  );
}
