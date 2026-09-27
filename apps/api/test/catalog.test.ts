import {
  itemDetailSchema,
  itemPageSchema,
  mediaLinksSchema,
} from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { makeFixtures } from "./fixtures";
import { createTestApp } from "./setup";

describe("catalog routes", () => {
  it("serves types, genres, countries", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const types = await app.inject({ method: "GET", url: "/v1/types" });
    expect(types.statusCode).toBe(200);
    expect(types.json().types.length).toBe(8);

    const genres = await app.inject({ method: "GET", url: "/v1/genres" });
    expect(genres.statusCode).toBe(200);
    expect(genres.json().genres.map((g: { id: number }) => g.id)).toContain(ids.genre);

    const countries = await app.inject({ method: "GET", url: "/v1/countries" });
    expect(countries.statusCode).toBe(200);
    expect(countries.json().countries[0].title).toBeTruthy();
  });

  it("lists items with filters and cursor pagination", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const all = await app.inject({ method: "GET", url: "/v1/items?sort=id" });
    expect(all.statusCode).toBe(200);
    const page1 = itemPageSchema.parse(all.json());
    expect(page1.items.map((i) => i.id)).toEqual([ids.movie, ids.serial]);
    expect(page1.nextCursor).toBeNull();

    const filtered = await app.inject({
      method: "GET",
      url: `/v1/items?type=movie&genre=${ids.genre}&country=${ids.country}`,
    });
    expect(itemPageSchema.parse(filtered.json()).items.map((i) => i.id)).toEqual([
      ids.movie,
    ]);

    const byActor = await app.inject({
      method: "GET",
      url: `/v1/items?actor=${encodeURIComponent("Киану")}`,
    });
    expect(itemPageSchema.parse(byActor.json()).items.length).toBe(2);

    // Пагинация: limit=1 → курсор → вторая страница без дублей.
    const first = await app.inject({ method: "GET", url: "/v1/items?sort=views-&limit=1" });
    const firstPage = itemPageSchema.parse(first.json());
    expect(firstPage.items[0]!.id).toBe(ids.serial);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/v1/items?sort=views-&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    });
    const secondPage = itemPageSchema.parse(second.json());
    expect(secondPage.items[0]!.id).toBe(ids.movie);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("searches by title and cast", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const byTitle = await app.inject({
      method: "GET",
      url: `/v1/items/search?q=${encodeURIComponent("Матрица")}`,
    });
    expect(itemPageSchema.parse(byTitle.json()).items.map((i) => i.id)).toEqual([
      ids.movie,
    ]);

    const byCast = await app.inject({
      method: "GET",
      url: `/v1/items/search?q=${encodeURIComponent("Киану")}&field=cast`,
    });
    expect(itemPageSchema.parse(byCast.json()).items.length).toBe(2);

    const missing = await app.inject({
      method: "GET",
      url: `/v1/items/search?q=${encodeURIComponent("Неттакого")}`,
    });
    expect(itemPageSchema.parse(missing.json()).items).toEqual([]);
  });

  it("returns item detail for movie and serial, 404 for unknown", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const movie = await app.inject({ method: "GET", url: `/v1/items/${ids.movie}` });
    expect(movie.statusCode).toBe(200);
    const movieDetail = itemDetailSchema.parse(movie.json());
    expect(movieDetail.title).toBe("Матрица");
    expect(movieDetail.media?.length).toBe(1);
    expect(movieDetail.seasons).toBeNull();

    const serial = await app.inject({ method: "GET", url: `/v1/items/${ids.serial}` });
    const serialDetail = itemDetailSchema.parse(serial.json());
    expect(serialDetail.seasons?.[0]?.episodes.length).toBe(1);
    expect(serialDetail.seasons?.[0]?.episodes[0]?.title).toBe("Зима близко");

    const unknown = await app.inject({ method: "GET", url: "/v1/items/99999" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
  });

  it("serves media-links and rejects mismatched pairs", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const links = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.movie}/media-links?mid=${ids.movieMedia}`,
    });
    expect(links.statusCode).toBe(200);
    const parsed = mediaLinksSchema.parse(links.json());
    expect(parsed.files[0]!.urls.http).toBe("http://cdn.test/m/matrix/1080.mp4");
    expect(parsed.files[0]!.urls.hls).toBe("http://cdn.test/m/matrix/1080/index.m3u8");
    expect(parsed.audios[0]!.type).toBe("mvo");
    expect(parsed.subtitles[0]!.lang).toBe("eng");

    // media не принадлежит этому item → 404
    const wrong = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.serial}/media-links?mid=${ids.movieMedia}`,
    });
    expect(wrong.statusCode).toBe(404);
  });

  it("serves similar items and shortcuts", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const similar = await app.inject({
      method: "GET",
      url: `/v1/items/${ids.movie}/similar`,
    });
    expect(itemPageSchema.parse(similar.json()).items.map((i) => i.id)).toEqual([
      ids.serial,
    ]);

    for (const kind of ["fresh", "hot", "popular"]) {
      const res = await app.inject({ method: "GET", url: `/v1/items/${kind}` });
      expect(res.statusCode).toBe(200);
      expect(itemPageSchema.parse(res.json()).items.length).toBe(2);
    }

    const hot = await app.inject({ method: "GET", url: "/v1/items/hot" });
    expect(itemPageSchema.parse(hot.json()).items[0]!.id).toBe(ids.serial);
  });
});

describe("docs", () => {
  it("serves OpenAPI spec with paths and components", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toContain("/v1/items");
    expect(spec.components.schemas.ItemSummary).toBeDefined();
    expect(spec.components.schemas.AuthResponse).toBeDefined();

    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.statusCode).toBe(200);
    expect(docs.body).toContain("Зал API");
  });
});
