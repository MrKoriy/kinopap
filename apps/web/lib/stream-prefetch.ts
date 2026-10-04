"use client";

/**
 * Префетч источника при наведении/фокусе на карточку: сервер фоном находит
 * раздачу, и клик «Смотреть» берёт готовое (POST /v1/items/:id/prefetch).
 * Работает и для гостей.
 *
 * Не спамим API: дебаунс (пролёт мыши по ленте ничего не шлёт), один
 * запрос на тайтл за TTL и потолок запросов в минуту на вкладку. При
 * экономии трафика (Save-Data) префетч выключен.
 */
import * as React from "react";
import { useOptionalAuth } from "@/lib/auth";

export const PREFETCH_DEBOUNCE_MS = 300;
const PREFETCH_TTL_MS = 10 * 60 * 1000;
const PREFETCH_PER_MINUTE = 12;

/** Решает, слать ли префетч: дедуп по тайтлу за TTL + окно «N в минуту». */
export function createPrefetchGate(opts: { ttlMs: number; perMinute: number }) {
  const sent = new Map<number, number>();
  let windowStart = 0;
  let windowCount = 0;
  return {
    allow(itemId: number, now = Date.now()): boolean {
      const prev = sent.get(itemId);
      if (prev != null && now - prev < opts.ttlMs) return false;
      if (now - windowStart >= 60_000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount >= opts.perMinute) return false;
      windowCount++;
      sent.set(itemId, now);
      // Память не растёт бесконечно на длинной сессии.
      if (sent.size > 500) {
        for (const [id, at] of sent) if (now - at >= opts.ttlMs) sent.delete(id);
      }
      return true;
    },
  };
}

/** Один шлюз на вкладку: карточки в разных лентах делят лимит. */
const gate = createPrefetchGate({ ttlMs: PREFETCH_TTL_MS, perMinute: PREFETCH_PER_MINUTE });

function saveData(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return conn?.saveData === true;
}

/**
 * Намерение посмотреть тайтл: `intent()` на mouseenter/focus, `cancel()` на
 * mouseleave/blur. Запрос уходит, только если намерение продержалось
 * PREFETCH_DEBOUNCE_MS; `now()` — без дебаунса (наведение на «Смотреть»).
 */
export function useStreamPrefetch(itemId: number) {
  const api = useOptionalAuth()?.api ?? null;
  const timer = React.useRef<number | null>(null);

  const fire = React.useCallback(() => {
    if (!api || saveData() || !gate.allow(itemId)) return;
    void api.prefetchItem(itemId).catch(() => {});
  }, [api, itemId]);

  const cancel = React.useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const intent = React.useCallback(() => {
    if (timer.current != null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      fire();
    }, PREFETCH_DEBOUNCE_MS);
  }, [fire]);

  React.useEffect(() => cancel, [cancel]);

  return { intent, cancel, now: fire };
}
