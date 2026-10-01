/** Форматирование для всех клиентов: время, длительность, даты. */

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

/** Длительность в секундах → "1:23:45" / "12:34"; null → "". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return "";
  return formatTime(totalSeconds);
}

/**
 * Длительность тайтла/серии в секундах → «2 ч 16 мин» / «46 мин»; null → "".
 *
 * Отличие от formatDuration: та даёт таймкод «2:16:00» — он уместен в плеере,
 * а в карточке/списке серий читается как момент времени, а не длительность.
 */
export function formatDurationHuman(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || totalSeconds <= 0) return "";
  return formatRuntime(Math.round(totalSeconds / 60));
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

/* ---------- Русская плюрализация и относительное время ---------- */

/** Русская форма по числу: 1 минуту / 2 минуты / 5 минут. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * «2 часа назад» для свежих записей и абсолютная дата для старых: недельная
 * давность в часах читается хуже календаря. `now` — число (мс эпохи) или Date,
 * инъектируется для детерминированных тестов.
 *
 * Веб и мобила раньше держали две разные реализации (Intl против ручного
 * склонения) с разными порогами — теперь одна на оба клиента.
 */
export function formatRelativeTime(iso: string, now: number | Date = Date.now()): string {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diffMs = nowMs - then.getTime();
  // Метка из будущего (сбитые часы клиента) — не «через -3 минуты».
  if (diffMs < 60_000) return "только что";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes} ${pluralRu(minutes, "минуту", "минуты", "минут")} назад`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${pluralRu(hours, "час", "часа", "часов")} назад`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} ${pluralRu(days, "день", "дня", "дней")} назад`;
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(then);
}
