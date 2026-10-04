/**
 * RUM: Web Vitals и TTFF плеера → POST /v1/metrics батчами.
 *
 * sendBeacon с text/plain — без CORS-preflight и переживает закрытие
 * вкладки; фолбэк — fetch keepalive. Очередь сбрасывается каждые 5 с,
 * при 10 событиях и при уходе со страницы.
 */
import { API_BASE } from "@/lib/api";

export interface RumEvent {
  name: "LCP" | "TTFB" | "FCP" | "INP" | "CLS" | "TTFF";
  value: number;
  page?: string;
  itemId?: number;
  rating?: "good" | "needs-improvement" | "poor";
  meta?: Record<string, string | number | boolean | null>;
}

const queue: RumEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let bound = false;

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0 || typeof window === "undefined") return;
  const events = queue.splice(0, 20);
  const body = JSON.stringify({ events });
  const url = `${API_BASE}/v1/metrics`;
  try {
    const sent =
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
    if (!sent) {
      void fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(
        () => {},
      );
    }
  } catch {
    // метрики — не повод ронять страницу
  }
  if (queue.length > 0) flush();
}

export function reportRum(event: RumEvent): void {
  if (typeof window === "undefined" || !Number.isFinite(event.value) || event.value < 0) return;
  if (!bound) {
    bound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  }
  queue.push({ ...event, page: event.page ?? window.location.pathname });
  if (queue.length >= 10) flush();
  else if (!timer) timer = setTimeout(flush, 5000);
}

/**
 * Откуда API взял ссылки на поток (Server-Timing `resolve;desc=…` ответа
 * media-links, читается через Resource Timing): live — живой резолв, то
 * есть «холодный старт». null — не знаем (запрос не нашёлся / нет заголовка).
 */
export function resolveSourceOf(itemId: number, mediaId: number): string | null {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const needle = `/v1/items/${itemId}/media-links`;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!e.name.includes(needle) || !e.name.includes(`mid=${mediaId}`)) continue;
    const st = (e.serverTiming ?? []).find((t) => t.name === "resolve");
    if (st) return st.description || null;
  }
  return null;
}
