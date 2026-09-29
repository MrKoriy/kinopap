/**
 * WebVTT для мобильного оверлея: нативный HLS внешние дорожки не принимает,
 * поэтому парсим файл сами и рисуем реплику поверх видео.
 * Реализация — @zal/shared, тот же парсер на вебе.
 */
import { parseVtt, type SubtitleCue } from "@zal/shared";

export {
  activeCues,
  cueAt,
  parseVtt,
  type SubtitleCue,
} from "@zal/shared";

/**
 * Загрузка дорожки: fetch + проверка статуса + парсинг. Без проверки
 * response.ok битая дорожка выглядит как успешный парс нуля реплик, и
 * выключается молча — поэтому не-2xx и сетевой сбой бросают ошибку.
 */
export async function fetchSubtitleCues(url: string): Promise<SubtitleCue[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Дорожка не загрузилась: HTTP ${res.status}`);
  }
  return parseVtt(await res.text());
}
