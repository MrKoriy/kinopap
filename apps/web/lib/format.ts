/** Форматирование: общее с мобильным клиентом — @zal/shared. */
export {
  formatDate,
  formatDuration,
  formatDurationHuman,
  formatRuntime,
  formatShift,
  formatTime,
} from "@zal/shared";

/** Рейтинг для карточки: свой (голоса) → IMDb → TMDb → Кинопоиск. */
export function displayRating(item: {
  rating: number;
  imdb: { rating: number | null };
  tmdb?: { rating: number | null };
  kinopoisk?: { rating: number | null };
}): number | null {
  if (item.rating > 0) return item.rating;
  for (const r of [item.imdb.rating, item.tmdb?.rating ?? null, item.kinopoisk?.rating ?? null]) {
    if (r != null && r > 0) return r;
  }
  return null;
}
