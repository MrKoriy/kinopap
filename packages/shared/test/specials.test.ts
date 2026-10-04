import type { ItemDetail } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { episodeGroups, nextEpisode } from "../src/episodes";
import { mediaSlotLabel } from "../src/watch";

const ep = (id: number, number: number) => ({ id, number, title: null, thumbnailUrl: null, runtime: 0, mediaId: id * 10 });

const item = {
  seasons: [{ id: 1, number: 1, title: null, episodes: [ep(1, 1), ep(2, 2)] }],
  media: null,
  specials: { id: 9, number: 0, title: null, episodes: [ep(7, 1), ep(8, 2)] },
} as unknown as ItemDetail;

describe("спецвыпуски", () => {
  it("отдельная группа в конце меню", () => {
    const groups = episodeGroups(item);
    expect(groups.map((g) => [g.heading, g.special ?? false])).toEqual([
      ["Сезон 1", false],
      ["Спецвыпуски", true],
    ]);
  });

  it("финал сезона не уводит в спешлы, спешл ведёт к следующему спешлу", () => {
    const groups = episodeGroups(item);
    expect(nextEpisode(groups, 20)).toBeNull();
    expect(nextEpisode(groups, 10)?.mediaId).toBe(20);
    expect(nextEpisode(groups, 70)?.mediaId).toBe(80);
  });

  it("подпись слота", () => {
    expect(mediaSlotLabel(item, 80)).toBe("Спецвыпуск 2");
  });
});
