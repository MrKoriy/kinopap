/**
 * Чистые форматтеры личного кабинета: относительное время, подпись позиции
 * в истории и русская плюрализация. Живут вне компонента, чтобы тестировать
 * без DOM и API — вёрстка меняется чаще, чем эти правила.
 */
import type { HistoryEntryDto } from "@zal/api-client";

/** Русская форма по числу: 1 минуту / 2 минуты / 5 минут. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * «2 часа назад» для свежих записей и абсолютная дата для старых (недельная
 * давность в часах читается хуже календаря). `now` инъектируется — тесты
 * детерминированы, рантайм берёт текущее время.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diffMs = now.getTime() - then.getTime();
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
  const sameYear = then.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(then);
}

/**
 * Подпись позиции в истории: серия «S2E4 · Серия 4», часть «Часть 2» или
 * название медиа. Пустая строка — у фильма без уточнений подпись не нужна,
 * название тайтла строка показывает отдельно.
 */
export function historyPositionLabel(
  entry: Pick<
    HistoryEntryDto,
    "seasonNumber" | "episodeNumber" | "partNumber" | "mediaTitle"
  >,
): string {
  if (entry.seasonNumber != null && entry.episodeNumber != null) {
    const se = `S${entry.seasonNumber}E${entry.episodeNumber}`;
    return entry.mediaTitle ? `${se} · ${entry.mediaTitle}` : se;
  }
  if (entry.partNumber != null) {
    const part = `Часть ${entry.partNumber}`;
    return entry.mediaTitle ? `${part} · ${entry.mediaTitle}` : part;
  }
  return entry.mediaTitle ?? "";
}

/** «март 2026 г.» — дата регистрации без дня и времени. */
export function formatMemberSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(d);
}
