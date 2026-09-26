import { describe, expect, it } from "vitest";
import { TmdbEnricher } from "../src";

function mockFetch(payload: unknown, capture: string[] = []) {
  return (async (input: unknown) => {
    capture.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("TmdbEnricher (легальный TMDb API, мок-транспорт)", () => {
  it("маппит movie-результат в enrichment", async () => {
    const urls: string[] = [];
    const enricher = new TmdbEnricher({
      apiKey: "test-key",
      fetch: mockFetch(
        {
          results: [
            {
              id: 603,
              overview: "Хакер узнаёт правду о мире.",
              original_title: "The Matrix",
              release_date: "1999-03-31",
              vote_average: 8.2,
              vote_count: 25000,
              poster_path: "/matrix.jpg",
            },
          ],
        },
        urls,
      ),
    });

    const found = await enricher.find({
      title: "Матрица",
      year: 1999,
      type: "movie",
    });

    expect(urls[0]).toContain("/search/movie");
    expect(urls[0]).toContain("api_key=test-key");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      tmdbId: 603,
      plot: "Хакер узнаёт правду о мире.",
      originalTitle: "The Matrix",
      year: 1999,
      tmdbRating: 8.2,
      tmdbVotes: 25000,
      posterMedium: "https://image.tmdb.org/t/p/w500/matrix.jpg",
    });
    expect(found[0]?.posterBig).toContain("/original/matrix.jpg");
  });

  it("serial идёт в /search/tv", async () => {
    const urls: string[] = [];
    const enricher = new TmdbEnricher({
      apiKey: "test-key",
      fetch: mockFetch({ results: [] }, urls),
    });
    await enricher.find({ title: "Игра престолов", type: "serial" });
    expect(urls[0]).toContain("/search/tv");
  });

  it("обрабатывает пустой результат и отсутствие постера", async () => {
    const enricher = new TmdbEnricher({
      apiKey: "k",
      fetch: mockFetch({ results: [{ id: 1, vote_average: 0, vote_count: 0 }] }),
    });
    const found = await enricher.find({ title: "Неттакого", type: "movie" });
    expect(found[0]?.posterMedium).toBeNull();
    expect(found[0]?.year).toBeNull();
  });

  it("падает с понятной ошибкой на HTTP-ошибке", async () => {
    const enricher = new TmdbEnricher({
      apiKey: "k",
      fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    await expect(enricher.find({ title: "x", type: "movie" })).rejects.toThrow(
      /tmdb: HTTP 500/,
    );
  });
});
