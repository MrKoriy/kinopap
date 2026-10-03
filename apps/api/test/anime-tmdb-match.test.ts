import { describe, expect, it } from "vitest";
import { pickTmdbAnime } from "../src/lib/anime-tmdb-match";

describe("pickTmdbAnime", () => {
  const rows = [
    { id: 1, genre_ids: [16], original_language: "ja", first_air_date: "2020-10-03", popularity: 50 },
    { id: 2, genre_ids: [18], original_language: "ja", first_air_date: "2020-10-03", popularity: 90 },
    { id: 3, genre_ids: [16], original_language: "en", first_air_date: "2020-01-01", popularity: 99 },
    { id: 4, genre_ids: [16], original_language: "ja", first_air_date: "2015-01-01", popularity: 80 },
    { id: 5, genre_ids: [16], original_language: "ja", first_air_date: "2021-04-01", popularity: 70 },
  ];
  it("анимация, азиатский оригинал, год ±1, самый популярный", () => {
    expect(pickTmdbAnime(rows, 2020)?.id).toBe(5);
    expect(pickTmdbAnime(rows, 2015)?.id).toBe(4);
    expect(pickTmdbAnime(rows, 2010)).toBeNull();
  });
});
