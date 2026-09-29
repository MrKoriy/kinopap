/**
 * Правила слотов и подписей — тесты переехали сюда из мобильного клиента и из
 * веб-профиля: сама логика теперь общая, значит и проверяться должна в одном
 * месте. Дублируй мы тесты по клиентам, расхождение подписей снова прошло бы
 * незамеченным — ровно это и случилось с «Продолжить Часть 2».
 */
import type { HistoryEntryDto, ItemDetail, ItemProgressEntry, Season } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import {
  historyPositionLabel,
  historySlotCode,
  latestInProgressEntry,
  mediaSlotLabel,
  pickDefaultSeason,
  primaryPlayLabel,
  seasonIndexForMedia,
} from "../src/watch";

function makeItem(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id: 1,
    type: "serial",
    subtype: null,
    title: "Тест",
    originalTitle: null,
    year: 2020,
    plot: null,
    cast: [],
    director: [],
    duration: { average: null, total: null },
    langs: 0,
    ac3: false,
    quality: null,
    genres: [],
    countries: [],
    imdb: { id: null, rating: null, votes: null },
    kinopoisk: { id: null, rating: null, votes: null },
    tmdb: { id: null, rating: null, votes: null },
    rating: 0,
    votes: { positive: 0, negative: 0, total: 0 },
    views: 0,
    finished: null,
    advert: false,
    posters: { small: null, medium: null, big: null },
    trailer: { id: null, url: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seasons: null,
    media: null,
    ...over,
  };
}

function season(id: number, number: number, mediaIds: (number | null)[]): Season {
  return {
    id,
    number,
    title: null,
    episodes: mediaIds.map((mediaId, i) => ({
      id: id * 100 + i,
      number: i + 1,
      title: null,
      thumbnailUrl: null,
      runtime: 0,
      mediaId,
    })),
  };
}

describe("mediaSlotLabel", () => {
  const item = makeItem({
    seasons: [season(10, 2, [101, 102])],
    media: [{ id: 5, partNumber: 1, title: null, thumbnailUrl: null, runtime: 0 }],
  });

  it("серия подписывается S{сезон}E{номер}", () => {
    expect(mediaSlotLabel(item, 102)).toBe("S2E2");
  });

  it("часть фильма — «Часть N»", () => {
    expect(mediaSlotLabel(item, 5)).toBe("Часть 1");
  });

  it("неизвестный media — null", () => {
    expect(mediaSlotLabel(item, 999)).toBeNull();
  });

  // Отдельно: у аниме без сезонов `seasons` пуст, а контент лежит частями в
  // `media`. Если бы функция смотрела только сезоны, такой тайтл не нашёлся бы.
  it("аниме без сезонов — часть находится в media", () => {
    const anime = makeItem({
      media: [{ id: 7, partNumber: 2, title: null, thumbnailUrl: null, runtime: 0 }],
    });
    expect(mediaSlotLabel(anime, 7)).toBe("Часть 2");
  });

  it("null на входе — null, а не поиск по дереву", () => {
    expect(mediaSlotLabel(item, null)).toBeNull();
  });
});

describe("primaryPlayLabel", () => {
  const series = makeItem({ seasons: [season(10, 2, [101, 102, 103, 104])] });
  const parts = (n: number) =>
    makeItem({
      media: Array.from({ length: n }, (_, i) => ({
        id: 5 + i,
        partNumber: i + 1,
        title: null,
        thumbnailUrl: null,
        runtime: 0,
      })),
    });

  it("без resume — «Смотреть»", () => {
    expect(primaryPlayLabel(series, null)).toBe("Смотреть");
  });

  it("сериал с resume — «Продолжить S2E4»", () => {
    expect(primaryPlayLabel(series, 104)).toBe("Продолжить S2E4");
  });

  it("многочастевый фильм с resume — «Продолжить Часть 2»", () => {
    expect(primaryPlayLabel(parts(2), 6)).toBe("Продолжить Часть 2");
  });

  // Единственная часть — это не «часть», а сам фильм. Подпись «Продолжить
  // Часть 1» тут читалась бы как издевательство, поэтому правило отдельное.
  it("одночастевый фильм с resume — всё равно «Смотреть»", () => {
    expect(primaryPlayLabel(parts(1), 5)).toBe("Смотреть");
  });

  it("resume на media, которой в тайтле нет — «Продолжить» без уточнения", () => {
    expect(primaryPlayLabel(series, 999)).toBe("Продолжить");
  });

  // У пустого тайтла (ни серий, ни частей) назвать слот нечем, но это не повод
  // обещать «Смотреть», когда точка возобновления есть.
  it("пустой тайтл: без resume — «Смотреть», с resume — «Продолжить»", () => {
    expect(primaryPlayLabel(makeItem(), null)).toBe("Смотреть");
    expect(primaryPlayLabel(makeItem(), 1)).toBe("Продолжить");
  });
});

describe("historySlotCode", () => {
  const base = { seasonNumber: null, episodeNumber: null, partNumber: null };

  it("серия — S/E", () => {
    expect(historySlotCode({ ...base, seasonNumber: 2, episodeNumber: 4 })).toBe("S2E4");
  });

  it("часть — «Часть N»", () => {
    expect(historySlotCode({ ...base, partNumber: 2 })).toBe("Часть 2");
  });

  it("ничего не указано — null", () => {
    expect(historySlotCode(base)).toBeNull();
  });

  // Часть важнее отсутствия сезона: у многочастевого фильма сезонов нет вовсе.
  it("часть без сезона распознаётся", () => {
    expect(historySlotCode({ ...base, partNumber: 1 })).toBe("Часть 1");
  });
});

describe("historyPositionLabel", () => {
  const base = {
    seasonNumber: null,
    episodeNumber: null,
    partNumber: null,
    mediaTitle: null,
  };

  it("серия: S/E с названием", () => {
    expect(
      historyPositionLabel({ ...base, seasonNumber: 2, episodeNumber: 4, mediaTitle: "Серия 4" }),
    ).toBe("S2E4 · Серия 4");
  });

  it("серия без названия — только S/E (веб)", () => {
    expect(historyPositionLabel({ ...base, seasonNumber: 1, episodeNumber: 1 })).toBe("S1E1");
  });

  it("часть", () => {
    expect(historyPositionLabel({ ...base, partNumber: 2 })).toBe("Часть 2");
  });

  it("название медиа", () => {
    expect(historyPositionLabel({ ...base, mediaTitle: "Режиссёрская версия" })).toBe(
      "Режиссёрская версия",
    );
  });

  it("фильм без уточнений — пусто (веб)", () => {
    expect(historyPositionLabel(base)).toBe("");
  });

  // Мобильный клиент показывает ровно эту строку, поэтому у него есть запасной
  // вариант и дефолтная подпись серии — см. opts в сигнатуре.
  it("fallback подставляется, когда уточнять нечего (мобильный)", () => {
    expect(historyPositionLabel(base, { fallback: "Тайтл" })).toBe("Тайтл");
  });

  it("episodeTitle дописывается к серии без названия (мобильный)", () => {
    expect(
      historyPositionLabel(
        { ...base, seasonNumber: 2, episodeNumber: 4 },
        { episodeTitle: "Серия 4" },
      ),
    ).toBe("S2E4 · Серия 4");
  });

  // Название самого media важнее подставленного: «S2E4 · Финал», не «Серия 4».
  it("название media побеждает episodeTitle", () => {
    expect(
      historyPositionLabel(
        { ...base, seasonNumber: 2, episodeNumber: 4, mediaTitle: "Финал" },
        { episodeTitle: "Серия 4" },
      ),
    ).toBe("S2E4 · Финал");
  });

  it("fallback не подменяет название media", () => {
    expect(historyPositionLabel({ ...base, mediaTitle: "Финал" }, { fallback: "Тайтл" })).toBe(
      "Финал",
    );
  });

  it("принимает запись истории целиком", () => {
    const entry: HistoryEntryDto = {
      itemId: 1,
      mediaId: 2,
      itemTitle: "Тайтл",
      posterMedium: null,
      type: "serial",
      seasonNumber: 2,
      episodeNumber: 4,
      partNumber: null,
      mediaTitle: null,
      positionSeconds: 0,
      durationSeconds: 0,
      progress: 0,
      status: "in_progress",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(historyPositionLabel(entry, { episodeTitle: "Серия 4" })).toBe("S2E4 · Серия 4");
  });
});

/* ---------- Выбор сезона по прогрессу ---------- */

function entry(over: Partial<ItemProgressEntry>): ItemProgressEntry {
  return {
    mediaId: 1,
    positionSeconds: 0,
    durationSeconds: 100,
    progress: 0,
    status: "unwatched",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function progress(
  entries: ItemProgressEntry[],
  resumeMediaId: number | null = null,
): { entries: ItemProgressEntry[]; resumeMediaId: number | null } {
  return { entries, resumeMediaId };
}

describe("pickDefaultSeason", () => {
  const seasons = [season(10, 1, [101, 102]), season(20, 2, [201, 202])];

  it("без прогресса — первый сезон", () => {
    expect(pickDefaultSeason(seasons, null)).toBe(10);
  });

  it("берёт сезон самой свежей начатой серии", () => {
    const p = progress([
      entry({ mediaId: 101, status: "in_progress", updatedAt: "2026-02-01T00:00:00.000Z" }),
      entry({ mediaId: 201, status: "in_progress", updatedAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(pickDefaultSeason(seasons, p)).toBe(20);
  });

  it("досмотренные серии сезон не выбирают", () => {
    const p = progress([entry({ mediaId: 201, status: "watched", progress: 1 })]);
    expect(pickDefaultSeason(seasons, p)).toBe(10);
  });

  it("нет сезонов — null", () => {
    expect(pickDefaultSeason([], null)).toBeNull();
  });

  it("равные метки — первый сезон по порядку списка", () => {
    const p = progress([
      entry({ mediaId: 201, status: "in_progress", updatedAt: "2026-02-01T00:00:00.000Z" }),
      entry({ mediaId: 101, status: "in_progress", updatedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(pickDefaultSeason(seasons, p)).toBe(10);
  });

  it("начатая серия вне дерева сезонов не выбирает сезон", () => {
    const p = progress([entry({ mediaId: 999, status: "in_progress" })]);
    expect(pickDefaultSeason(seasons, p)).toBe(10);
  });

  it("метки в разных форматах сравниваются хронологически, а не по строкам", () => {
    // Лексикографически "…T23:00:00+05:00" больше "…T19:00:00.000Z",
    // хронологически (18:00Z) — меньше. Выбрать должен 19:00Z, то есть сезон 10.
    const p = progress([
      entry({ mediaId: 201, status: "in_progress", updatedAt: "2026-03-01T23:00:00+05:00" }),
      entry({ mediaId: 101, status: "in_progress", updatedAt: "2026-03-01T19:00:00.000Z" }),
    ]);
    expect(pickDefaultSeason(seasons, p)).toBe(10);
  });

  it("нет начатых, но есть resumeMediaId — сезон точки возобновления (поведение веба)", () => {
    expect(pickDefaultSeason(seasons, progress([], 202))).toBe(20);
  });

  it("resumeMediaId вне сезонов или null — первый сезон", () => {
    expect(pickDefaultSeason(seasons, progress([], 999))).toBe(10);
    expect(pickDefaultSeason(seasons, progress([]))).toBe(10);
  });
});

describe("latestInProgressEntry", () => {
  it("берёт запись с самой свежей меткой", () => {
    const p = progress([
      entry({ mediaId: 101, status: "in_progress", updatedAt: "2026-02-01T00:00:00.000Z" }),
      entry({ mediaId: 201, status: "in_progress", updatedAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(latestInProgressEntry(p)?.mediaId).toBe(201);
  });

  it("смотренные и не начатые не считаются", () => {
    const p = progress([
      entry({ mediaId: 101, status: "watched" }),
      entry({ mediaId: 201, status: "unwatched" }),
    ]);
    expect(latestInProgressEntry(p)).toBeNull();
  });

  it("битая метка не кандидат и не блокирует последующие записи", () => {
    const p = progress([
      entry({ mediaId: 101, status: "in_progress", updatedAt: "не дата" }),
      entry({ mediaId: 201, status: "in_progress", updatedAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(latestInProgressEntry(p)?.mediaId).toBe(201);
  });

  it("без прогресса — null", () => {
    expect(latestInProgressEntry(null)).toBeNull();
  });
});

describe("seasonIndexForMedia", () => {
  const item = makeItem({ seasons: [season(10, 1, [101, 102]), season(20, 2, [201, 202])] });

  it("серия находится по mediaId — индекс её сезона", () => {
    expect(seasonIndexForMedia(item, 201)).toBe(1);
    expect(seasonIndexForMedia(item, 102)).toBe(0);
  });

  it("чужая media или null — null", () => {
    expect(seasonIndexForMedia(item, 999)).toBeNull();
    expect(seasonIndexForMedia(item, null)).toBeNull();
  });

  it("сезонов нет — null", () => {
    expect(seasonIndexForMedia(makeItem(), 101)).toBeNull();
  });
});
