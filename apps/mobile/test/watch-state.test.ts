import type {
  HistoryEntryDto,
  ItemDetail,
  ItemProgressDto,
  ItemProgressEntry,
  Season,
} from "@zal/api-client";
import { describe, expect, it } from "vitest";
import {
  firstPlayableMediaId,
  historyLabel,
  mediaLabel,
  pickDefaultSeason,
  primaryPlay,
  progressByMedia,
  watchStateOf,
} from "../lib/watch-state";

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

function progress(entries: ItemProgressEntry[], resumeMediaId: number | null = null): ItemProgressDto {
  return { itemId: 1, entries, resumeMediaId, resumePositionSeconds: 0 };
}

describe("watchStateOf", () => {
  it("без записи — не начато", () => {
    expect(watchStateOf(undefined)).toEqual({ kind: "none" });
  });

  it("watched — досмотрено", () => {
    expect(watchStateOf(entry({ status: "watched", progress: 1 }))).toEqual({ kind: "done" });
  });

  it("in_progress с долей — полоска", () => {
    expect(watchStateOf(entry({ status: "in_progress", progress: 0.42 }))).toEqual({
      kind: "progress",
      progress: 0.42,
    });
  });

  it("нулевой прогресс — не начато, доля клампится", () => {
    expect(watchStateOf(entry({ status: "in_progress", progress: 0 }))).toEqual({ kind: "none" });
    expect(watchStateOf(entry({ status: "in_progress", progress: 1.5 }))).toEqual({
      kind: "progress",
      progress: 1,
    });
  });
});

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
});

describe("mediaLabel / firstPlayableMediaId", () => {
  const item = makeItem({
    seasons: [season(10, 2, [101, 102])],
    media: [{ id: 5, partNumber: 1, title: null, thumbnailUrl: null, runtime: 0 }],
  });

  it("серия подписывается S{сезон}E{номер}", () => {
    expect(mediaLabel(item, 102)).toBe("S2E2");
  });

  it("часть фильма — «Часть N»", () => {
    expect(mediaLabel(item, 5)).toBe("Часть 1");
  });

  it("неизвестный media — null", () => {
    expect(mediaLabel(item, 999)).toBeNull();
  });

  it("первая доступная — первая серия с файлом", () => {
    expect(firstPlayableMediaId(item)).toBe(101);
  });

  it("серии без файла пропускаются в пользу части", () => {
    const partsOnly = makeItem({
      seasons: [season(10, 1, [null, null])],
      media: [{ id: 7, partNumber: 2, title: null, thumbnailUrl: null, runtime: 0 }],
    });
    expect(firstPlayableMediaId(partsOnly)).toBe(7);
  });
});

describe("primaryPlay", () => {
  it("одночастевый фильм — «Смотреть» на единственную часть", () => {
    const film = makeItem({
      media: [{ id: 9, partNumber: 1, title: null, thumbnailUrl: null, runtime: 0 }],
    });
    expect(primaryPlay(film, progress([], 9))).toEqual({ mediaId: 9, label: "Смотреть" });
  });

  it("сериал с resumeMediaId — «Продолжить S2E4»", () => {
    const series = makeItem({ seasons: [season(10, 2, [101, 102, 103, 104])] });
    expect(primaryPlay(series, progress([], 104))).toEqual({
      mediaId: 104,
      label: "Продолжить S2E4",
    });
  });

  it("сериал без прогресса — «Смотреть» на первую серию", () => {
    const series = makeItem({ seasons: [season(10, 1, [101, 102])] });
    expect(primaryPlay(series, null)).toEqual({ mediaId: 101, label: "Смотреть" });
  });

  it("нет играбельного media — null", () => {
    expect(primaryPlay(makeItem(), null)).toBeNull();
  });
});

describe("progressByMedia", () => {
  it("индексирует записи по mediaId", () => {
    const map = progressByMedia(progress([entry({ mediaId: 3 }), entry({ mediaId: 4 })]));
    expect(map.get(3)?.mediaId).toBe(3);
    expect(map.get(9)).toBeUndefined();
  });
});

describe("historyLabel", () => {
  const base: HistoryEntryDto = {
    itemId: 1,
    mediaId: 2,
    itemTitle: "Тайтл",
    posterMedium: null,
    type: "serial",
    seasonNumber: null,
    episodeNumber: null,
    partNumber: null,
    mediaTitle: null,
    positionSeconds: 0,
    durationSeconds: 0,
    progress: 0,
    status: "in_progress",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("серия — «S2E4 · Серия 4»", () => {
    expect(
      historyLabel({ ...base, seasonNumber: 2, episodeNumber: 4, mediaTitle: "Серия 4" }),
    ).toBe("S2E4 · Серия 4");
  });

  it("серия без имени media — дефолтная подпись", () => {
    expect(historyLabel({ ...base, seasonNumber: 2, episodeNumber: 4 })).toBe("S2E4 · Серия 4");
  });

  it("часть фильма — «Часть 2»", () => {
    expect(historyLabel({ ...base, partNumber: 2 })).toBe("Часть 2");
  });

  it("иначе — имя media или тайтл", () => {
    expect(historyLabel({ ...base, mediaTitle: "Финал" })).toBe("Финал");
    expect(historyLabel(base)).toBe("Тайтл");
  });
});
