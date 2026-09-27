/** Форматирование времени плеера: "1:23:45" / "12:34". */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "136 мин" / "1 ч 16 мин". */
export function formatRuntime(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** Длительность в секундах → "1:23:45" / "12:34"; null/undefined → "". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return "";
  return formatTime(totalSeconds);
}

/** Дата комментария/публикации: "12 марта 2026, 14:33". */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatShift(ms: number): string {
  return ms > 0 ? `+${ms} мс` : `${ms} мс`;
}
