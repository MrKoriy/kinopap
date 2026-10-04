/**
 * Фолбэк раскладки без эпизод-групп TMDb: куры по паузам в датах выхода,
 * сплошные длинные куры — блоками по 26 с подписью сквозного диапазона.
 */
import { describe, expect, it } from "vitest";
import { courLayout } from "../src/lib/season-layout";

const DAY = 86_400_000;
const start = Date.UTC(2004, 9, 5);

/** n серий раз в неделю, с паузами (в днях) перед указанными сериями. */
function weekly(n: number, pauses: Record<number, number> = {}) {
  let t = start;
  return Array.from({ length: n }, (_, i) => {
    if (i > 0) t += 7 * DAY + (pauses[i] ?? 0) * DAY;
    return { id: i + 1, airDate: new Date(t) };
  });
}

describe("courLayout", () => {
  it("короткий сезон не трогает", () => {
    expect(courLayout(weekly(50))).toBeNull();
  });

  it("режет по паузам дольше трёх недель", () => {
    const groups = courLayout(weekly(75, { 24: 60, 50: 90 }))!;
    expect(groups.map((g) => g.episodeIds.length)).toEqual([24, 26, 25]);
    expect(groups.map((g) => g.title)).toEqual(["Серии 1–24", "Серии 25–50", "Серии 51–75"]);
  });

  it("сплошной поток — блоками по 26, короткий хвост в последний блок", () => {
    const groups = courLayout(weekly(80))!;
    expect(groups.map((g) => g.episodeIds.length)).toEqual([26, 26, 28]);
    expect(groups.at(-1)!.title).toBe("Серии 53–80");
    expect(groups.flatMap((g) => g.episodeIds)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
  });

  it("без дат — блоками по 26", () => {
    const flat = Array.from({ length: 104 }, (_, i) => ({ id: i + 1, airDate: null }));
    expect(courLayout(flat)!.map((g) => g.episodeIds.length)).toEqual([26, 26, 26, 26]);
  });

  it("одиночная серия после паузы (рекап) прилипает к предыдущему куру", () => {
    const groups = courLayout(weekly(77, { 40: 60, 41: 60 }))!;
    expect(groups.map((g) => g.episodeIds.length)).toEqual([41, 36]);
  });
});
