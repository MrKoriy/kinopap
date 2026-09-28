import { describe, expect, it } from "vitest";
import { trailerTarget } from "../lib/trailer";

describe("trailerTarget", () => {
  it("реальный ролик TMDb — каноничный watch-URL", () => {
    expect(
      trailerTarget({ title: "Матрица", year: 1999, trailer: { id: "dQw4w9WgXcQ", url: null } }),
    ).toEqual({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", label: "Трейлер" });
  });

  it("ссылка в любой форме тоже распознаётся", () => {
    expect(
      trailerTarget({
        title: "Матрица",
        year: 1999,
        trailer: { id: null, url: "https://youtu.be/dQw4w9WgXcQ" },
      }).url,
    ).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("нет ролика — поиск по названию с годом и честная подпись", () => {
    const target = trailerTarget({ title: "Матрица", year: 1999, trailer: { id: null, url: null } });
    expect(target.label).toBe("Найти трейлер");
    expect(target.url).toBe(
      `https://www.youtube.com/results?search_query=${encodeURIComponent("Матрица 1999 трейлер")}`,
    );
  });

  it("без года — поиск только по названию", () => {
    const target = trailerTarget({ title: "Матрица", year: null, trailer: { id: "", url: null } });
    expect(target.url).toContain(encodeURIComponent("Матрица трейлер"));
    expect(target.url).not.toContain("null");
  });
});
