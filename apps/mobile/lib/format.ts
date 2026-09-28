/** Форматирование мобильного клиента: общее с вебом — @zal/shared. */
import { formatDate } from "@zal/shared";

export { formatDate, formatDuration, formatRuntime, formatTime } from "@zal/shared";

/**
 * Относительное время для истории: «5 минут назад», «2 часа назад».
 * Старше недели — абсолютная дата: «43 дня назад» ничего не сообщает, а
 * formatDate из @zal/shared уже даёт ru-RU-строку с датой и временем.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return "только что";
  const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diffSec / 86400), "day");
  return formatDate(iso);
}
