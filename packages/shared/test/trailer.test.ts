import { describe, expect, it } from "vitest";
import {
  resolveTrailer,
  youtubeEmbedUrl,
  youtubeSearchEmbedUrl,
  youtubeVideoId,
  youtubeWatchUrl,
} from "../src/trailer";

const ID = "dQw4w9WgXcQ";

describe("youtubeVideoId", () => {
  it("понимает все формы ссылок YouTube", () => {
    expect(youtubeVideoId(ID)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://youtube.com/watch?v=${ID}&t=42s`)).toBe(ID);
    expect(youtubeVideoId(`https://youtu.be/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://youtu.be/${ID}?si=abc`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(youtubeVideoId(`//www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it("не считает видео плейлист, канал и мусор", () => {
    expect(youtubeVideoId("https://www.youtube.com/playlist?list=PL123")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/@channel")).toBeNull();
    expect(youtubeVideoId("https://vimeo.com/12345")).toBeNull();
    expect(youtubeVideoId("не ссылка")).toBeNull();
    expect(youtubeVideoId("")).toBeNull();
    expect(youtubeVideoId(null)).toBeNull();
    // Похожий хост, но не YouTube.
    expect(youtubeVideoId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});

describe("youtubeEmbedUrl / youtubeWatchUrl", () => {
  it("берёт id из поля id и из поля url", () => {
    expect(youtubeEmbedUrl({ id: ID, url: null })).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}`,
    );
    expect(youtubeEmbedUrl({ id: null, url: `https://youtu.be/${ID}` })).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}`,
    );
    expect(youtubeWatchUrl({ id: null, url: `https://youtu.be/${ID}` })).toBe(
      `https://www.youtube.com/watch?v=${ID}`,
    );
  });

  it("null, когда трейлера нет", () => {
    expect(youtubeEmbedUrl(null)).toBeNull();
    expect(youtubeEmbedUrl({ id: null, url: null })).toBeNull();
    expect(youtubeWatchUrl({ id: "", url: "https://vimeo.com/1" })).toBeNull();
  });
});

describe("resolveTrailer", () => {
  it("отдаёт реальный трейлер, когда он есть", () => {
    const r = resolveTrailer({
      title: "Матрица",
      year: 1999,
      trailer: { id: ID, url: `https://www.youtube.com/watch?v=${ID}` },
    });
    expect(r).toEqual({
      embedUrl: `https://www.youtube-nocookie.com/embed/${ID}`,
      source: "youtube",
    });
  });

  it("падает на поиск, когда трейлера нет", () => {
    const r = resolveTrailer({ title: "Матрица", year: 1999, trailer: { id: null, url: null } });
    expect(r?.source).toBe("search");
    expect(r?.embedUrl).toContain("listType=search");
    expect(r?.embedUrl).toContain(encodeURIComponent("Матрица 1999 трейлер"));
  });

  it("поиск можно запретить — тогда null", () => {
    const r = resolveTrailer(
      { title: "Матрица", trailer: null },
      { allowSearchFallback: false },
    );
    expect(r).toBeNull();
  });

  it("в поиск уходит год, если он есть", () => {
    expect(youtubeSearchEmbedUrl("Тест", null)).toContain(
      encodeURIComponent("Тест трейлер"),
    );
  });
});
