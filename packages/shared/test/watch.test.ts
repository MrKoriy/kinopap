/**
 * Правила слотов и подписей — тесты переехали сюда из мобильного клиента и из
 * веб-профиля: сама логика теперь общая, значит и проверяться должна в одном
 * месте. Дублируй мы тесты по клиентам, расхождение подписей снова прошло бы
 * незамеченным — ровно это и случилось с «Продолжить Часть 2».
 */
import type { HistoryEntryDto, ItemDetail, Season } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import {
  historyPositionLabel,
  historySlotCode,
  mediaSlotLabel,
  primaryPlayLabel,
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
