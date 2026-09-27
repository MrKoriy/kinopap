/**
 * WebVTT для мобильного оверлея: нативный HLS внешние дорожки не принимает,
 * поэтому парсим файл сами и рисуем реплику поверх видео.
 * Реализация — @zal/shared, тот же парсер на вебе.
 */
export {
  activeCues,
  cueAt,
  parseVtt,
  type SubtitleCue,
} from "@zal/shared";
