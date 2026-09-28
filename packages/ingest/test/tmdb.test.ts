import { describe, expect, it } from "vitest";
import { pickTrailer, TmdbEnricher } from "../src";

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

/** Мок, отвечающий разным телом в зависимости от пути запроса. */
function routedFetch(routes: Array<[string, unknown]>, urls: string[] = []) {
  return (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const hit = routes.find(([fragment]) => url.includes(fragment));
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("TmdbEnricher: трейлеры", () => {
  it("pickTrailer предпочитает официальный трейлер тизеру и игнорирует не-видео", () => {
    expect(
      pickTrailer([
        { key: "teaser11111", site: "YouTube", type: "Teaser", official: true },
        { key: "trailer1111", site: "YouTube", type: "Trailer", official: true },
        { key: "vimeo111111", site: "Vimeo", type: "Trailer", official: true },
      ]),
    ).toBe("trailer1111");

    // Неофициальный трейлер всё равно лучше, чем ничего.
    expect(
      pickTrailer([{ key: "unofficial1", site: "YouTube", type: "Trailer", official: false }]),
    ).toBe("unofficial1");

    // Только фичуретки — трейлера нет.
    expect(pickTrailer([{ key: "featurette1", site: "YouTube", type: "Featurette" }])).toBeNull();
    expect(pickTrailer([])).toBeNull();
  });

  it("trailer() берёт ru-RU, а при пустом ответе — en-US", async () => {
    const urls: string[] = [];
    const enricher = new TmdbEnricher({
      apiKey: "k",
      fetch: routedFetch(
        [
          ["language=ru-RU", { results: [] }],
          [
            "language=en-US",
            {
              results: [
                { key: "fallback111", site: "YouTube", type: "Trailer", official: true },
              ],
            },
          ],
        ],
        urls,
      ),
    });

    const trailer = await enricher.trailer({ type: "movie", tmdbId: 603 });
    expect(trailer).toEqual({
      id: "fallback111",
      url: "https://www.youtube.com/watch?v=fallback111",
    });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/movie/603/videos");
    expect(urls[0]).toContain("language=ru-RU");
    expect(urls[1]).toContain("language=en-US");
  });

  it("trailer() идёт в /tv для сериалов и молчит, когда роликов нет", async () => {
    const urls: string[] = [];
    const enricher = new TmdbEnricher({
      apiKey: "k",
      fetch: routedFetch([["/videos", { results: [] }]], urls),
    });
    expect(await enricher.trailer({ type: "serial", tmdbId: 1399 })).toBeNull();
    expect(urls[0]).toContain("/tv/1399/videos");
  });

  it("find() прикладывает трейлер к лучшему совпадению", async () => {
    const enricher = new TmdbEnricher({
      apiKey: "k",
      fetch: routedFetch([
        [
          "/search/movie",
          { results: [{ id: 603, original_title: "The Matrix", release_date: "1999-03-31" }] },
        ],
        [
          "/videos",
          {
            results: [
              { key: "ruTrailer11", site: "YouTube", type: "Trailer", official: true },
            ],
          },
        ],
      ]),
    });

    const found = await enricher.find({ title: "Матрица", year: 1999, type: "movie" });
    expect(found[0]?.trailerId).toBe("ruTrailer11");
    expect(found[0]?.trailerUrl).toBe("https://www.youtube.com/watch?v=ruTrailer11");
  });

  it("падение /videos не роняет обогащение", async () => {
    const enricher = new TmdbEnricher({
      apiKey: "k",
      fetch: routedFetch([
        ["/search/movie", { results: [{ id: 603, original_title: "The Matrix" }] }],
        // /videos отдаст 404 из routedFetch → trailer() вернёт null.
      ]),
    });

    const found = await enricher.find({ title: "Матрица", type: "movie" });
    expect(found[0]?.tmdbId).toBe(603);
    expect(found[0]?.trailerUrl).toBeUndefined();
  });
});
