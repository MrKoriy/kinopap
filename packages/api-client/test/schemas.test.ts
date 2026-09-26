import { describe, expect, it } from "vitest";
import {
  parseCatalogQuery,
  parseCsvInts,
  parseSort,
  parseYearRange,
  itemSummarySchema,
} from "../src/catalog";
import { registerSchema, loginSchema } from "../src/auth";

describe("parseSort", () => {
  it("defaults to updated desc", () => {
    expect(parseSort(undefined)).toEqual({ field: "updated", dir: "desc" });
    expect(parseSort("")).toEqual({ field: "updated", dir: "desc" });
  });

  it("parses kino.pub style 'field-' as desc and 'field' as asc", () => {
    expect(parseSort("rating-")).toEqual({ field: "rating", dir: "desc" });
    expect(parseSort("year")).toEqual({ field: "year", dir: "asc" });
  });

  it("falls back to default on unknown field", () => {
    expect(parseSort("views-count-")).toEqual({ field: "updated", dir: "desc" });
  });
});

describe("parseYearRange", () => {
  it("parses ranges and single years", () => {
    expect(parseYearRange("1990-2000")).toEqual({ yearFrom: 1990, yearTo: 2000 });
    expect(parseYearRange("2001")).toEqual({ yearFrom: 2001, yearTo: 2001 });
    expect(parseYearRange("1990-")).toEqual({ yearFrom: 1990, yearTo: 1990 });
    expect(parseYearRange("abc")).toEqual({});
    expect(parseYearRange(undefined)).toEqual({});
  });
});

describe("parseCsvInts", () => {
  it("parses valid lists and drops garbage", () => {
    expect(parseCsvInts("1,2,3")).toEqual([1, 2, 3]);
    expect(parseCsvInts(" 1 , 2 ")).toEqual([1, 2]);
    expect(parseCsvInts("1,x,-3")).toEqual([1]);
    expect(parseCsvInts("x")).toBeUndefined();
    expect(parseCsvInts(undefined)).toBeUndefined();
  });
});

describe("parseCatalogQuery", () => {
  it("assembles filters from raw query strings", () => {
    const f = parseCatalogQuery({
      type: "movie",
      title: "матрица",
      genre: "1,2",
      country: "3",
      year: "1990-2000",
      letter: "М",
      actor: "Киану Ривз",
      director: "Вачовски",
      sort: "rating-",
      limit: "50",
      cursor: "abc",
    });
    expect(f).toEqual({
      type: "movie",
      title: "матрица",
      genreIds: [1, 2],
      countryIds: [3],
      yearFrom: 1990,
      yearTo: 2000,
      letter: "М",
      actor: "Киану Ривз",
      director: "Вачовски",
      sort: { field: "rating", dir: "desc" },
      limit: 50,
      cursor: "abc",
    });
  });

  it("applies defaults and rejects bad enums", () => {
    const f = parseCatalogQuery({});
    expect(f.sort).toEqual({ field: "updated", dir: "desc" });
    expect(f.limit).toBe(25);
    expect(() => parseCatalogQuery({ type: "hentai" })).toThrow();
  });
});

describe("auth schemas", () => {
  it("accepts a valid registration", () => {
    expect(
      registerSchema.safeParse({
        invite: "ABC123XYZ90",
        email: "user@zal.local",
        password: "hunter2hunter2",
        name: "Larp",
      }).success,
    ).toBe(true);
  });

  it("rejects short password and bad email", () => {
    expect(
      registerSchema.safeParse({
        invite: "ABC123XYZ90",
        email: "not-an-email",
        password: "short",
        name: "x",
      }).success,
    ).toBe(false);
  });

  it("requires a password for login", () => {
    expect(loginSchema.safeParse({ email: "a@b.co" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });
});

describe("itemSummarySchema", () => {
  it("parses a full DTO", () => {
    const dto = {
      id: 1,
      type: "movie",
      subtype: null,
      title: "Матрица",
      originalTitle: "The Matrix",
      year: 1999,
      plot: "Хакер узнаёт правду",
      cast: ["Киану Ривз"],
      director: ["Вачовски"],
      duration: { average: 136, total: 136 },
      langs: 2,
      ac3: true,
      quality: 1080,
      genres: [{ id: 1, title: "Фантастика" }],
      countries: [{ id: 1, title: "США" }],
      imdb: { id: 133093, rating: 8.7, votes: 2000000 },
      kinopoisk: { id: 301, rating: 8.6, votes: 500000 },
      tmdb: { id: 603, rating: 8.2, votes: 25000 },
      rating: 1200,
      votes: { positive: 1300, negative: 100, total: 1400 },
      views: 15,
      finished: null,
      advert: false,
      posters: { small: null, medium: "m.jpg", big: "b.jpg" },
      trailer: { id: "vX", url: "https://youtube.com/watch?v=vX" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(itemSummarySchema.parse(dto)).toEqual(dto);
  });
});
