/**
 * Куда открыть трейлер с карточки тайтла. Ролик — каноничный YouTube
 * watch-URL; если ролика нет, отдаём честный поиск по названию и помечаем
 * кнопку «Найти трейлер», чтобы не выдавать поиск за сам трейлер.
 */
import { youtubeWatchUrl } from "@zal/shared";

export interface TrailerTarget {
  url: string;
  label: string;
}

type TrailerItem = {
  title: string;
  year: number | null;
  trailer: { id: string | null; url: string | null };
};

export function trailerTarget(item: TrailerItem): TrailerTarget {
  const watch = youtubeWatchUrl(item.trailer);
  if (watch) return { url: watch, label: "Трейлер" };
  const query = item.year ? `${item.title} ${item.year} трейлер` : `${item.title} трейлер`;
  return {
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    label: "Найти трейлер",
  };
}
