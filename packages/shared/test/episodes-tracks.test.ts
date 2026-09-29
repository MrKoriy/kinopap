import type { ItemDetail } from "@zal/api-client";
import { describe, expect, it, vi } from "vitest";
import { episodeGroups, flattenEpisodes, nextEpisode } from "../src/episodes";
import { pollMediaTracks } from "../src/tracks";

const serial = {
  seasons: [
    {
      number: 1,
      title: null,
      episodes: [
        { mediaId: 11, number: 1, title: "Пилот" },
        { mediaId: 12, number: 2, title: null },
        // Серия без media — играть нечем, в список не попадает.
        { mediaId: null, number: 3, title: "битая" },
      ],
    },
    { number: 2, title: "Сезон 2", episodes: [{ mediaId: 21, number: 1, title: null }] },
  ],
  media: [],
} as unknown as Pick<ItemDetail, "seasons" | "media">;

const parts = {
  seasons: [],
  media: [
    { id: 101, partNumber: 1, title: "Часть 1" },
    { id: 102, partNumber: 2, title: null },
  ],
} as unknown as Pick<ItemDetail, "seasons" | "media">;

describe("episodeGroups", () => {
  it("сезоны сериала группируются, серии без media пропускаются", () => {
    const groups = episodeGroups(serial);
    expect(groups.map((g) => g.heading)).toEqual(["Сезон 1", "Сезон 2"]);
    expect(groups[0]!.episodes.map((e) => e.label)).toEqual(["S1E1", "S1E2"]);
  });

  it("у тайтла без сезонов — единственная группа «Части»", () => {
    const groups = episodeGroups(parts);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.episodes.map((e) => e.label)).toEqual(["Часть 1", "Часть 2"]);
  });
});

describe("nextEpisode", () => {
  it("следующая серия внутри сезона и через границу сезонов", () => {
    const groups = episodeGroups(serial);
    expect(nextEpisode(groups, 11)?.mediaId).toBe(12);
    expect(nextEpisode(groups, 12)?.mediaId).toBe(21);
  });

  it("последняя серия и чужой mediaId — null", () => {
    const groups = episodeGroups(serial);
    expect(nextEpisode(groups, 21)).toBeNull();
    expect(nextEpisode(groups, 999)).toBeNull();
  });

  it("flatten и nextEpisode согласованы с порядком меню", () => {
    const groups = episodeGroups(serial);
    const flat = flattenEpisodes(groups);
    expect(flat.map((e) => e.mediaId)).toEqual([11, 12, 21]);
  });
});

describe("pollMediaTracks", () => {
  it("первая непустая проба отдаёт дорожки и останавливается", async () => {
    vi.useFakeTimers();
    try {
      const empty = { audios: [] };
      const loaded = { audios: [{ track: 1 }] };
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(empty)
        .mockResolvedValueOnce(empty)
        .mockResolvedValueOnce(loaded);
      const onLoaded = vi.fn();
      const stop = pollMediaTracks(fetcher, onLoaded);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(onLoaded).toHaveBeenCalledWith([{ track: 1 }]);

      // Дальше не спрашивает: дорожки уже есть.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).toHaveBeenCalledTimes(3);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ретраи исчерпаны — сдаётся, ошибки не роняют плеер", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockRejectedValue(new Error("gst недоступен"));
      const onLoaded = vi.fn();
      const stop = pollMediaTracks(fetcher, onLoaded);

      await vi.advanceTimersByTimeAsync(4_000 + 8_000 * 3);
      // Первая проба + 2 ретрая.
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(onLoaded).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() отменяет незапущенные таймеры", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn();
      const stop = pollMediaTracks(fetcher, vi.fn());
      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
