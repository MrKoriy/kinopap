/**
 * Ошибки браузера → POST /v1/errors (лента Ops и Sentry через API).
 * sendBeacon с text/plain, не больше 10 ошибок за жизнь вкладки и без
 * повторов одного текста — зациклившийся рендер не зальёт API.
 */
import { API_BASE } from "@/lib/api";

const MAX_PER_PAGE = 10;
const seen = new Set<string>();
let sent = 0;

export function reportError(err: unknown, extra: { page?: string } = {}): void {
  if (typeof window === "undefined" || sent >= MAX_PER_PAGE) return;
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err ?? null));
  const message = `${e.name}: ${e.message}`.slice(0, 2000);
  if (seen.has(message)) return;
  seen.add(message);
  sent++;
  const body = JSON.stringify({
    errors: [
      {
        message,
        stack: e.stack?.slice(0, 8000),
        page: (extra.page ?? window.location.pathname + window.location.search).slice(0, 200),
        release: process.env.NEXT_PUBLIC_RELEASE || undefined,
      },
    ],
  });
  const url = `${API_BASE}/v1/errors`;
  try {
    const ok = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
    if (!ok) void fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
  } catch {
    // репортёр ошибок не должен сам ронять страницу
  }
}

let installed = false;

/** Глобальные обработчики: window.onerror и необработанные промисы. */
export function installErrorReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    // Ошибки загрузки картинок/скриптов приходят без error — это не баги кода.
    if (ev.error) reportError(ev.error);
  });
  window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason));
}
