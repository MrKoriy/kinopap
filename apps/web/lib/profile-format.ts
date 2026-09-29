/**
 * Чистые форматтеры личного кабинета. Плюрализация и относительное время
 * живут в `@zal/shared` (одни правила для веба и мобилы), здесь — только
 * специфика кабинета вроде даты регистрации.
 *
 * Подпись позиции в истории сюда не входит: это правило предметной области, а
 * не формат личного кабинета, и оно общее с мобильным клиентом — см.
 * `historyPositionLabel` в `@zal/shared`.
 */
import { formatRelativeTime, pluralRu } from "@zal/shared";

export { formatRelativeTime, pluralRu };

/** «март 2026 г.» — дата регистрации без дня и времени. */
export function formatMemberSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(d);
}
