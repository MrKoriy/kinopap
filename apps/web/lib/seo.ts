/**
 * SEO тайтла: JSON-LD Movie/TVSeries и картинки для OpenGraph/Twitter.
 * Чистые функции — страница только сериализует результат.
 */
import type { ItemDetail, ItemType } from "@zal/api-client";
import { absoluteUrl } from "@/lib/site";

const SERIAL_TYPES: ReadonlySet<ItemType> = new Set(["serial", "docuserial", "tvshow", "anime"]);

/** Сериал по смыслу: сериальный тип, а у аниме — наличие сезонов. */
export function isSeriesLike(item: Pick<ItemDetail, "type" | "seasons">): boolean {
  if (item.type === "anime") return (item.seasons?.length ?? 0) > 0;
  return SERIAL_TYPES.has(item.type);
}

/** ISO 8601 длительность из секунд: 8100 → «PT2H15M». */
export function isoDuration(seconds: number | null | undefined): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  return `PT${h ? `${h}H` : ""}${m % 60 ? `${m % 60}M` : h ? "" : "0M"}`;
}

/** OG-картинка: бэкдроп 16:9 (так её режут соцсети), иначе постер. */
export function ogImages(item: Pick<ItemDetail, "backdrop" | "posters" | "title">) {
  if (item.backdrop) return [{ url: item.backdrop, width: 1280, height: 720, alt: item.title }];
  const poster = item.posters.big ?? item.posters.medium;
  return poster ? [{ url: poster, alt: item.title }] : undefined;
}

/** Абсолютный URL картинки: свои нарезки лежат относительным путём /img/… */
const abs = (u: string | null | undefined) => (u ? absoluteUrl(u) : undefined);

export function itemJsonLd(item: ItemDetail): Record<string, unknown> {
  const series = isSeriesLike(item);
  const rating = item.imdb.rating ?? item.tmdb.rating ?? (item.rating > 0 ? item.rating : null);
  const votes = item.imdb.rating ? item.imdb.votes : item.tmdb.votes;
  const actors = (item.credits?.cast ?? []).slice(0, 10).map((p) => ({ "@type": "Person", name: p.name }));
  const directors = (item.credits?.crew ?? []).filter((p) => p.role === "director").map((p) => ({ "@type": "Person", name: p.name }));
  const fallbackActors = actors.length ? actors : item.cast.slice(0, 10).map((name) => ({ "@type": "Person", name }));
  const fallbackDirectors = directors.length ? directors : item.director.map((name) => ({ "@type": "Person", name }));

  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": series ? "TVSeries" : "Movie",
    name: item.title,
    url: absoluteUrl(`/item/${item.id}`),
    image: [abs(item.posters.big ?? item.posters.medium), abs(item.backdrop)].filter(Boolean),
  };
  if (item.originalTitle && item.originalTitle !== item.title) ld.alternateName = item.originalTitle;
  if (item.plot) ld.description = item.plot;
  if (item.year) ld[series ? "startDate" : "datePublished"] = String(item.year);
  if (item.genres.length) ld.genre = item.genres.map((g) => g.title);
  if (item.countries.length) ld.countryOfOrigin = item.countries.map((c) => ({ "@type": "Country", name: c.title }));
  if (fallbackActors.length) ld.actor = fallbackActors;
  if (fallbackDirectors.length) ld.director = fallbackDirectors;
  if (!series) {
    const d = isoDuration(item.duration.average);
    if (d) ld.duration = d;
  } else if (item.seasons?.length) {
    ld.numberOfSeasons = item.seasons.length;
    ld.numberOfEpisodes = item.seasons.reduce((n, s) => n + s.episodes.length, 0);
  }
  if (rating && votes && votes > 0) {
    ld.aggregateRating = { "@type": "AggregateRating", ratingValue: rating, bestRating: 10, ratingCount: votes };
  }
  if (item.trailer.url && item.trailer.id) {
    ld.trailer = {
      "@type": "VideoObject",
      name: `${item.title} — трейлер`,
      embedUrl: `https://www.youtube.com/embed/${item.trailer.id}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${item.trailer.id}/hqdefault.jpg`,
      uploadDate: item.createdAt,
    };
  }
  return ld;
}

/** Сериализация в <script>: «<» экранируется — строка из БД не закроет тег. */
export function serializeJsonLd(ld: Record<string, unknown>): string {
  return JSON.stringify(ld).replace(/</g, "\\u003c");
}
