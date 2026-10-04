import type { AniMedia } from "@zal/ingest";
import { describe, expect, it } from "vitest";
import { nightlyTasks } from "../src/autopilot";
import { missingNumbers, summarizeGaps } from "../src/lib/audit-rules";
import { buildEntries, buildTitleIndex, franchiseTitle, matchEntry } from "../src/lib/franchise-match";
import { makePacer, pagedById, runPool } from "../src/lib/script";

const m = (id: number, romaji: string, year: number, format = "TV", english?: string): AniMedia => ({
  id,
  title: { romaji, english },
  format,
  startDate: { year },
});

describe("quality-audit rules", () => {
  it("missingNumbers и summarizeGaps", () => {
    expect(missingNumbers([1, 2, 4, 7])).toEqual([3, 5, 6]);
    expect(summarizeGaps([{ season: 1, numbers: [1, 2, 4] }])).toEqual([{ season: 1, missing: [3] }]);
    // продолжение с 26 без дыр — offset, не дыра
    expect(summarizeGaps([{ season: 2, numbers: [26, 27, 28] }])).toEqual([{ season: 2, missing: [], offset: 26 }]);
  });
});

describe("franchise-match", () => {
  const idx = buildTitleIndex([
    { id: 1, title: "Атака титанов", originalTitle: "Shingeki no Kyojin", year: 2013, views: 100, type: "serial" },
    { id: 2, title: "Атака титанов: Фильм", originalTitle: "Shingeki no Kyojin Movie", year: 2015, views: 5, type: "movie" },
    { id: 3, title: "Shingeki no Kyojin Movie", originalTitle: null, year: 2001, views: 50, type: "movie" },
  ]);

  it("matchEntry: название + год ±1 + тип", () => {
    expect(matchEntry(idx, m(9, "Shingeki no Kyojin Movie", 2015, "MOVIE"))?.id).toBe(2);
    expect(matchEntry(idx, m(9, "Shingeki no Kyojin", 2013, "MOVIE"))).toBeNull();
  });

  it("buildEntries: сезоны без своей карточки ведут на стартовую", () => {
    const entries = buildEntries(
      [m(16498, "Shingeki no Kyojin", 2013), m(20958, "Shingeki no Kyojin Season 2", 2017, "TV", "Attack on Titan Season 2"), m(5, "Shingeki no Kyojin Movie", 2015, "MOVIE"), m(6, "Totally Other", 2016, "OVA")],
      idx,
      { anilistId: 16498, itemId: 1, title: "Атака титанов" },
    );
    expect(entries.map((e) => e.itemId)).toEqual([1, 1, 2, null]);
    expect(entries[1]?.title).toBe("Attack on Titan Season 2");
    expect(franchiseTitle(entries)).toBe("Атака титанов");
  });
});

describe("script helpers", () => {
  it("runPool раздаёт каждый элемент ровно одному воркеру", async () => {
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
    let call = 0;
    const seen: number[] = [];
    await runPool(pagedById(async () => pages[call++] ?? [], 100), 4, async (r) => {
      seen.push(r.id);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it("makePacer держит темп", async () => {
    const pace = makePacer(20);
    const t = Date.now();
    await Promise.all([pace(), pace(), pace()]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(35);
  });

  it("nightlyTasks: NIGHTLY_SKIP выключает задачи по имени", () => {
    const all = nightlyTasks({});
    expect(all.map((t) => t.script)).toContain("franchises.ts");
    const some = nightlyTasks({ NIGHTLY_SKIP: "credits,intros" });
    expect(some.map((t) => t.script)).not.toContain("backfill-credits.ts");
    expect(some.map((t) => t.script)).not.toContain("intros.ts");
  });
});
