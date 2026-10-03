import {
  itemDetailSchema,
  itemPageSchema,
  itemsSummaryResponseSchema,
  mediaLinksSchema,
} from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { makeFixtures, memberAuth } from "./fixtures";
import { createTestApp } from "./setup";

describe("catalog routes", () => {
  it("serves types, genres, countries", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    const types = await app.inject({ method: "GET", url: "/v1/types" });
    expect(types.statusCode).toBe(200);
    // movie, serial, anime, concert, documovie, docuserial, tvshow, 3d, 4k
    expect(types.json().types.length).toBe(9);
    expect(types.json().types.map((t: { id: string }) => t.id)).toContain("anime");

    const genres = await app.inject({ method: "GET", url: "/v1/genres" });
    expect(genres.statusCode).toBe(200);
    expect(genres.json().genres.map((g: { id: number }) => g.id)).toContain(ids.genre);

    const typedGenres = await app.inject({ method: "GET", url: "/v1/genres?type=movie" });
    expect(typedGenres.statusCode).toBe(200);
    expect(typedGenres.json().genres.map((g: { id: number }) => g.id)).toContain(ids.genre);

    const countries = await app.inject({ method: "GET", url: "/v1/countries" });
    expect(countries.statusCode).toBe(200);
    expect(countries.json().countries[0].title).toBeTruthy();
  });

  it("повторённый type в query /genres — 400, а не 500", async () => {
    const { app } = await createTestApp();

    // Раньше /genres парсил query raw-`.parse`: ZodError падала в unified
    // error handler как 500 internal. fastify склеивает повторённый ключ
    // в массив, z.string() его отвергает.
    const res = await app.inject({ method: "GET", url: "/v1/genres?type=a&type=b" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    expect(res.json().error.details.length).toBeGreaterThan(0);
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

  it("serves items summary batch by ids", async () => {
    const { app, db } = await createTestApp();
    const ids = await makeFixtures(db);

    // Порядок ответа — порядок ids; отсутствующие id пропускаются.
    const res = await app.inject({
      method: "GET",
      url: `/v1/items/summary?ids=${ids.serial},${ids.movie},99999`,
    });
    expect(res.statusCode).toBe(200);
    // Форма DTO — как у списка каталога (валидна схемой api-client).
    const body = itemsSummaryResponseSchema.parse(res.json());
    expect(body.items.map((i) => i.id)).toEqual([ids.serial, ids.movie]);
    expect(body.items[1]!.title).toBe("Матрица");

    // Пустой результат — валидный пустой items, а не 404.
    const empty = await app.inject({
      method: "GET",
      url: "/v1/items/summary?ids=99998,99999",
    });
    expect(empty.statusCode).toBe(200);
    expect(itemsSummaryResponseSchema.parse(empty.json()).items).toEqual([]);
  });

  it("validates items summary ids: required, int, cap 50", async () => {
    const { app, db } = await createTestApp();
    await makeFixtures(db);

    const missing = await app.inject({ method: "GET", url: "/v1/items/summary" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("validation_error");

    const garbage = await app.inject({
      method: "GET",
      url: "/v1/items/summary?ids=1,abc",
    });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().error.code).toBe("validation_error");

    // Cap: 51 валидный id — уже 400.
    const overflow = Array.from({ length: 51 }, (_, i) => i + 1).join(",");
    const tooMany = await app.inject({
      method: "GET",
      url: `/v1/items/summary?ids=${overflow}`,
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe("validation_error");
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
      headers: await memberAuth(app, db),
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
      headers: await memberAuth(app, db),
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
