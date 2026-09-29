import { decodeCursor, parseCatalogQuery } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import {
  getItem,
  getItemsByIds,
  listItems,
  listItemsMissingTrailer,
  markTrailerChecked,
  mediaLinks,
  searchItems,
  setItemTrailer,
  shortcutItems,
  similarItems,
} from "../src/repos/catalog";
import * as schema from "../src/schema/index";
import { createTestDb, seedFixtures } from "./helpers";

describe("listItems", () => {
  it("filters by type and year range", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);

    const movies = await listItems(db, {
      type: "movie",
      sort: { field: "year", dir: "asc" },
      limit: 10,
    });
    expect(movies.items.map((i) => i.id)).toEqual([ids.matrix, ids.reloaded]);

    const nineties = await listItems(db, {
      type: "movie",
      yearFrom: 1990,
      yearTo: 2000,
      sort: { field: "year", dir: "asc" },
      limit: 10,
    });
    expect(nineties.items.map((i) => i.id)).toEqual([ids.matrix]);
  });

  it("filters by genre, country, letter, actor, director", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);

    const scifi = await listItems(db, {
      genreIds: [ids.genreScifi],
      sort: { field: "id", dir: "asc" },
      limit: 10,
    });
    expect(scifi.items.map((i) => i.id).sort()).toEqual(
      [ids.matrix, ids.reloaded].sort(),
    );

    const usa = await listItems(db, {
      countryIds: [ids.countryUsa],
      sort: { field: "id", dir: "asc" },
      limit: 10,
    });
    expect(usa.items.map((i) => i.id)).toEqual([ids.matrix]);

    const byLetter = await listItems(db, {
      letter: "М",
      sort: { field: "id", dir: "asc" },
      limit: 10,
    });
    expect(byLetter.items.length).toBe(2);

    const byActor = await listItems(db, {
      actor: "Киану",
      sort: { field: "id", dir: "asc" },
      limit: 10,
    });
    expect(byActor.items.map((i) => i.id).sort()).toEqual(
      [ids.matrix, ids.reloaded].sort(),
    );

    const byDirector = await listItems(db, {
      director: "Вачовски",
      sort: { field: "id", dir: "asc" },
      limit: 10,
    });
    expect(byDirector.items.length).toBe(2);
  });

  it("paginates with cursor without duplicates", async () => {
    const db = await createTestDb();
    await seedFixtures(db);

    const all = await listItems(db, {
      sort: { field: "views", dir: "desc" },
      limit: 10,
    });
    expect(all.items.length).toBe(3);
    expect(all.nextCursor).toBeNull();

    const first = await listItems(db, {
      sort: { field: "views", dir: "desc" },
      limit: 2,
    });
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]!.views).toBe(100);

    const second = await listItems(db, {
      sort: { field: "views", dir: "desc" },
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.length).toBe(1);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(3);
  });

  it("works end-to-end from raw query strings", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);
    const filters = parseCatalogQuery({ type: "movie", sort: "rating-", limit: "1" });
    const page = await listItems(db, filters);
    expect(page.items.map((i) => i.id)).toEqual([ids.matrix]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)?.s).toBe("rating");
  });
});

describe("searchItems", () => {
  it("finds by title substring and trgm similarity", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);

    const byTitle = await searchItems(db, { q: "Матрица", limit: 10 });
    expect(byTitle.items.map((i) => i.id).sort()).toEqual(
      [ids.matrix, ids.reloaded].sort(),
    );

    const byCast = await searchItems(db, { q: "Киану", field: "cast", limit: 10 });
    expect(byCast.items.length).toBe(2);

    const byDirector = await searchItems(db, {
      q: "Вачовски",
      field: "director",
      limit: 10,
    });
    expect(byDirector.items.length).toBe(2);

    const none = await searchItems(db, { q: "Несуществующийфильм", limit: 10 });
    expect(none.items).toEqual([]);
  });
});

describe("getItemsByIds", () => {
  it("возвращает карточки в порядке входных ids", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);

    // Порядок на входе не совпадает с порядком в БД.
    const summaries = await getItemsByIds(db, [ids.got, ids.matrix, ids.reloaded]);
    expect(summaries.map((i) => i.id)).toEqual([ids.got, ids.matrix, ids.reloaded]);
    expect(summaries[1]!.title).toBe("Матрица");
    // Проекция — как у списка каталога: карточка summary с refs.
    expect(summaries[1]!.cast).toEqual(["Киану Ривз"]);
    expect(summaries[1]!.genres.map((g) => g.title)).toEqual(["Фантастика"]);
  });

  it("схлопывает дубли и пропускает отсутствующие id", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);

    const summaries = await getItemsByIds(db, [
      ids.matrix,
      ids.matrix,
      99999,
      ids.reloaded,
    ]);
    expect(summaries.map((i) => i.id)).toEqual([ids.matrix, ids.reloaded]);
  });

  it("пустой вход — пустой ответ без запросов к БД", async () => {
    const db = await createTestDb();
    await seedFixtures(db);
    expect(await getItemsByIds(db, [])).toEqual([]);
  });
});

describe("getItem", () => {
  it("returns movie detail with media parts", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);
    const detail = await getItem(db, ids.matrix);
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe("Матрица");
    expect(detail!.cast).toEqual(["Киану Ривз"]);
    expect(detail!.director).toEqual(["Вачовски"]);
    expect(detail!.seasons).toBeNull();
    expect(detail!.media?.length).toBe(1);
    expect(detail!.genres.map((g) => g.title)).toEqual(["Фантастика"]);
  });

  it("returns serial detail with seasons and episodes", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);
    const detail = await getItem(db, ids.got);
    expect(detail!.seasons?.length).toBe(1);
    const season = detail!.seasons![0]!;
    expect(season.number).toBe(1);
    expect(season.episodes.length).toBe(2);
    expect(season.episodes[0]!.title).toBe("Зима близко");
    expect(season.episodes[0]!.mediaId).toBeGreaterThan(0);
    expect(detail!.media).toBeNull();
  });

  it("returns null for unknown id", async () => {
    const db = await createTestDb();
    expect(await getItem(db, 99999)).toBeNull();
  });
});

describe("mediaLinks", () => {
  it("builds http+hls urls from keys and rejects wrong item", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);
    const detail = await getItem(db, ids.matrix);
    const mediaId = detail!.media![0]!.id;

    const links = await mediaLinks(db, ids.matrix, mediaId, "http://cdn.local/m/");
    expect(links).not.toBeNull();
    expect(links!.files.length).toBe(2);
    expect(links!.files[0]!.quality).toBe("1080p");
    expect(links!.files[0]!.urls.http).toBe("http://cdn.local/m/matrix/1080.mp4");
    expect(links!.files[0]!.urls.hls).toBe("http://cdn.local/m/matrix/1080/index.m3u8");
    expect(links!.audios[0]!.type).toBe("mvo");
    expect(links!.audios[0]!.author.title).toBe("Видеосервис");
    expect(links!.subtitles[0]!.lang).toBe("eng");

    // media не принадлежит item → отказ
    expect(await mediaLinks(db, ids.got, mediaId, "http://cdn.local")).toBeNull();
  });
});

describe("similarItems + shortcuts", () => {
  it("finds similar by shared genre", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);
    const similar = await similarItems(db, ids.matrix);
    expect(similar.items.map((i) => i.id)).toEqual([ids.reloaded]);
  });

  it("orders fresh/hot/popular shortcuts", async () => {
    const db = await createTestDb();
    const ids = await seedFixtures(db);

    const hot = await shortcutItems(db, "hot", { limit: 10 });
    expect(hot.items[0]!.id).toBe(ids.got);

    const popular = await shortcutItems(db, "popular", { limit: 10 });
    expect(popular.items[0]!.id).toBe(ids.got);

    const fresh = await shortcutItems(db, "fresh", { limit: 10 });
    expect(fresh.items.length).toBe(3);
  });
});

describe("бэкфилл трейлеров: негативный кэш", () => {
  it("отмеченный «трейлера нет» выпадает из выборки на 90 дней", async () => {
    const db = await createTestDb();
    // У фикстур нет tmdbId — очередь бэкфилла их не видит.
    await db.insert(schema.items).values([
      { type: "movie", title: "С трейлером будет", tmdbId: 100 },
      { type: "movie", title: "Без трейлера", tmdbId: 200 },
    ]);

    const before = await listItemsMissingTrailer(db);
    expect(before.map((r) => r.tmdbId)).toEqual([100, 200]);

    // TMDb подтвердил отсутствие у второго.
    await markTrailerChecked(db, before.find((r) => r.tmdbId === 200)!.id);
    const afterMark = await listItemsMissingTrailer(db);
    expect(afterMark.map((r) => r.tmdbId)).toEqual([100]);

    // У первого нашли трейлер — тоже выпал.
    await setItemTrailer(db, before.find((r) => r.tmdbId === 100)!.id, {
      id: "yt123",
      url: "https://youtu.be/yt123",
    });
    const afterFound = await listItemsMissingTrailer(db);
    expect(afterFound).toEqual([]);
  });
});
