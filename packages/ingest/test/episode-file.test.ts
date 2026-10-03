import { describe, expect, it } from "vitest";
import { pickEpisodeFile } from "../src/lib/episode-file";

const f = (id: number, path: string, length = 1000 + id) => ({ id, path, length });

describe("pickEpisodeFile", () => {
  it("S01E05 и 1x05", () => {
    const files = [f(1, "Show.S01E04.1080p.mkv"), f(2, "Show.S01E05.1080p.mkv"), f(3, "Show.S01E05.sample.mkv", 10)];
    expect(pickEpisodeFile(files, 1, 5)?.id).toBe(2);
    expect(pickEpisodeFile([f(1, "show 1x04.avi"), f(2, "show 1x05.avi")], 1, 5)?.id).toBe(2);
  });
  it("пак другого сезона — null", () => {
    expect(pickEpisodeFile([f(1, "Show.S02E05.mkv")], 1, 5)).toBeNull();
  });
  it("номер серии токеном, без путаницы с 1080p/годом", () => {
    const files = [
      f(1, "Season 1/01. Пилот [1080p].mkv"),
      f(2, "Season 1/02. Вторая (2019) [1080p].mkv"),
      f(3, "Season 1/10. Десятая [1080p].mkv"),
    ];
    expect(pickEpisodeFile(files, 1, 2)?.id).toBe(2);
    expect(pickEpisodeFile(files, 1, 10)?.id).toBe(3);
    expect(pickEpisodeFile(files, 1, 8)).toBeNull();
  });
  it("аниме-пак со сквозной нумерацией", () => {
    const files = [f(1, "[Group] Bleach - 244 [720p][ABCDEF12].mkv"), f(2, "[Group] Bleach - 245 [720p][12345678].mkv")];
    expect(pickEpisodeFile(files, 12, 5, 245)?.id).toBe(2);
  });
  it("«Серия 5» и E05", () => {
    expect(pickEpisodeFile([f(1, "Серия 4.mp4"), f(2, "Серия 5.mp4")], 1, 5)?.id).toBe(2);
    expect(pickEpisodeFile([f(1, "Show E04.mp4"), f(2, "Show E05.mp4")], 1, 5)?.id).toBe(2);
  });
});
