import type { ItemDetail } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { isoDuration, itemJsonLd, ogImages, serializeJsonLd } from "@/lib/seo";

const base = {
  id: 7,
  type: "movie",
  title: "Сталкер",
  originalTitle: "Stalker",
  year: 1979,
  plot: "Зона </script>",
  cast: ["Кайдановский"],
  director: ["Тарковский"],
  duration: { average: 9660, total: 9660 },
  genres: [{ id: 1, title: "фантастика" }],
  countries: [{ id: 1, title: "СССР" }],
  imdb: { id: 1, rating: 8.1, votes: 140000 },
  tmdb: { id: 2, rating: 8.0, votes: 2000 },
  rating: 0,
  posters: { small: null, medium: "https://image.tmdb.org/t/p/w500/p.jpg", big: null },
  backdrop: "https://image.tmdb.org/t/p/w1280/b.jpg",
  trailer: { id: "abc", url: "https://www.youtube.com/watch?v=abc" },
  createdAt: "2026-01-01T00:00:00Z",
  seasons: null,
  media: null,
} as unknown as ItemDetail;

describe("SEO", () => {
  it("Movie: длительность, рейтинг, люди, трейлер", () => {
    const ld = itemJsonLd(base);
    expect(ld["@type"]).toBe("Movie");
    expect(ld.duration).toBe("PT2H41M");
    expect(ld.aggregateRating).toMatchObject({ ratingValue: 8.1, ratingCount: 140000 });
    expect(ld.director).toEqual([{ "@type": "Person", name: "Тарковский" }]);
    expect((ld.trailer as { embedUrl: string }).embedUrl).toBe("https://www.youtube.com/embed/abc");
  });

  it("TVSeries для сериалов, число сезонов и серий", () => {
    const ld = itemJsonLd({
      ...base,
      type: "serial",
      seasons: [{ id: 1, number: 1, title: null, episodes: [{ id: 1, number: 1, title: null, thumbnailUrl: null, runtime: 0, mediaId: 1 }] }],
    } as ItemDetail);
    expect(ld["@type"]).toBe("TVSeries");
    expect(ld.numberOfEpisodes).toBe(1);
  });

  it("OG — бэкдроп 16:9, иначе постер; сериализация экранирует «<»", () => {
    expect(ogImages(base)?.[0]).toMatchObject({ url: base.backdrop, width: 1280 });
    expect(ogImages({ ...base, backdrop: null })?.[0]?.url).toBe(base.posters.medium);
    expect(serializeJsonLd(itemJsonLd(base))).not.toContain("</script>");
    expect(isoDuration(3600)).toBe("PT1H");
  });
});
