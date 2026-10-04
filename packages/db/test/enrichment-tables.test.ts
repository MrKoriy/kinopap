/**
 * Титры, франшизы, спецвыпуски, аномалии и ручные раскладки сезонов.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applySeasonOverride,
  deleteEmptySeasons,
  episodes,
  findDuplicateEpisodes,
  findLongSeasons,
  findSeasonNumberings,
  getItem,
  getItemsByIds,
  items,
  listItemsMissingCredits,
  listOpenAnomalies,
  listPendingSeasonOverrides,
  loadTitleIndex,
  normTitle,
  people,
  qualityAnomalies,
  replaceItemCredits,
  saveFranchise,
  seasons,
  syncAnomalies,
  upsertSeasonOverride,
} from "../src/index";
import { createTestDb, type TestDb } from "./helpers";

let db: TestDb;

async function serial(title: string, layout: Record<number, number[]>) {
  const [it] = await db.insert(items).values({ type: "serial", title, tmdbId: Math.floor(Math.random() * 1e6) }).returning();
  for (const [num, eps] of Object.entries(layout)) {
    const [s] = await db.insert(seasons).values({ itemId: it!.id, number: Number(num) }).returning();
    if (eps.length) await db.insert(episodes).values(eps.map((n) => ({ seasonId: s!.id, number: n, title: `E${n}` })));
  }
  return it!.id;
}

beforeAll(async () => {
  db = await createTestDb();
});

describe("титры", () => {
  it("replaceItemCredits: люди дедупятся по tmdb_id, снимок заменяется, топ — по порядку", async () => {
    const [a] = await db.insert(items).values({ type: "movie", title: "Фильм A", tmdbId: 1 }).returning();
    const [b] = await db.insert(items).values({ type: "movie", title: "Фильм B", tmdbId: 2 }).returning();
    const cast = Array.from({ length: 8 }, (_, i) => ({
      tmdbId: 100 + i,
      name: `Актёр ${i}`,
      photoUrl: i === 0 ? "https://img/1.jpg" : null,
      role: "actor" as const,
      character: `Роль ${i}`,
      ord: i,
    }));
    await replaceItemCredits(db, a!.id, [...cast, { tmdbId: 900, name: "Режиссёр", photoUrl: null, role: "director", character: null, ord: 0 }], {
      backdropUrl: "https://image.tmdb.org/t/p/w1280/b.jpg",
    });
    await replaceItemCredits(db, b!.id, cast.slice(0, 2));
    // повтор — без дублей
    await replaceItemCredits(db, a!.id, [...cast, { tmdbId: 900, name: "Режиссёр", photoUrl: null, role: "director", character: null, ord: 0 }]);

    const ppl = await db.select().from(people);
    expect(ppl.filter((p) => p.tmdbId != null)).toHaveLength(9);

    const detail = await getItem(db, a!.id);
    expect(detail?.credits?.cast.map((c) => c.name)).toEqual(cast.map((c) => c.name));
    expect(detail?.credits?.cast[0]).toMatchObject({ character: "Роль 0", photoUrl: "https://img/1.jpg" });
    expect(detail?.credits?.crew).toEqual([expect.objectContaining({ name: "Режиссёр", role: "director" })]);
    expect(detail?.backdrop).toBe("https://image.tmdb.org/t/p/w1280/b.jpg");

    // в списках — урезанный каст
    const [summary] = await getItemsByIds(db, [a!.id]);
    expect(summary!.cast).toHaveLength(6);
    expect(summary!.director).toEqual(["Режиссёр"]);

    const missing = await listItemsMissingCredits(db, { limit: 50 });
    expect(missing.map((m) => m.id)).not.toContain(a!.id);
  });
});

describe("спецвыпуски", () => {
  it("сезон 0 уходит в specials, а не первым табом", async () => {
    const id = await serial("Шоу со спешлами", { 0: [1, 2], 1: [1, 2, 3] });
    const d = await getItem(db, id);
    expect(d?.seasons?.map((s) => s.number)).toEqual([1]);
    expect(d?.specials?.episodes.map((e) => e.number)).toEqual([1, 2]);
  });
});

describe("франшизы", () => {
  it("saveFranchise идемпотентна, getItem отдаёт части по порядку", async () => {
    const [s1] = await db.insert(items).values({ type: "anime", title: "Атака титанов", year: 2013 }).returning();
    const [m1] = await db.insert(items).values({ type: "anime", title: "Атака титанов: Фильм", year: 2015 }).returning();
    const input = {
      rootAnilistId: 16498,
      title: "Атака титанов",
      entries: [
        { anilistId: 16498, title: "Атака титанов", format: "TV", year: 2013, episodes: 25, itemId: s1!.id },
        { anilistId: 20958, title: "Фильм", format: "MOVIE", year: 2015, episodes: 1, itemId: m1!.id },
        { anilistId: 20811, title: "OVA", format: "OVA", year: 2014, episodes: 3, itemId: null },
      ],
    };
    const f1 = await saveFranchise(db, input);
    const f2 = await saveFranchise(db, input);
    expect(f2).toBe(f1);
    const d = await getItem(db, m1!.id);
    expect(d?.franchise?.entries.map((e) => e.format)).toEqual(["TV", "MOVIE", "OVA"]);
    expect(d?.franchise?.entries[0]?.itemId).toBe(s1!.id);
    const idx = await loadTitleIndex(db);
    expect(idx.some((r) => normTitle(r.title) === normTitle("атака  ТИТАНОВ"))).toBe(true);
  });
});

describe("quality-audit", () => {
  it("находит длинные сезоны, дыры, дубли и закрывает исчезнувшее", async () => {
    const long = await serial("Длинный", { 1: Array.from({ length: 65 }, (_, i) => i + 1) });
    const gap = await serial("С дырой", { 1: [1, 2, 4, 5] });
    const empty = await serial("Пустой сезон", { 1: [1], 2: [] });

    const ls = await findLongSeasons(db, 60);
    expect(ls.map((r) => Number(r.item_id))).toContain(long);
    const gaps = await findSeasonNumberings(db);
    expect(gaps.find((g) => Number(g.item_id) === gap)?.numbers.map(Number)).toEqual([1, 2, 4, 5]);
    expect(await findDuplicateEpisodes(db)).toEqual([]);

    expect(await deleteEmptySeasons(db)).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(seasons).where(eq(seasons.itemId, empty));
    expect(left).toHaveLength(1);

    await syncAnomalies(db, "long_season", [{ itemId: long, kind: "long_season", details: { episodes: 65 } }]);
    expect((await listOpenAnomalies(db, "long_season")).map((a) => a.itemId)).toEqual([long]);
    // ignored не переоткрывается
    await db.update(qualityAnomalies).set({ status: "ignored" }).where(eq(qualityAnomalies.itemId, long));
    await syncAnomalies(db, "long_season", [{ itemId: long, kind: "long_season", details: { episodes: 66 } }]);
    expect(await listOpenAnomalies(db, "long_season")).toEqual([]);
    // исчезло — resolved
    await syncAnomalies(db, "numbering_gap", [{ itemId: gap, kind: "numbering_gap", details: {} }]);
    const r = await syncAnomalies(db, "numbering_gap", []);
    expect(r.resolved).toBe(1);
  });

  it("season_overrides: раскладка применяется по координатам источника один раз", async () => {
    const id = await serial("Ручной", { 1: Array.from({ length: 10 }, (_, i) => i + 1) });
    await upsertSeasonOverride(db, id, {
      groups: [
        { title: "Арка 1", eps: [[1, 1], [1, 2], [1, 3], [1, 4]] },
        { title: null, eps: Array.from({ length: 6 }, (_, i) => [1, i + 5] as [number, number]) },
      ],
    });
    const pending = await listPendingSeasonOverrides(db);
    expect(pending.map((p) => p.itemId)).toContain(id);
    const res = await applySeasonOverride(db, id, pending.find((p) => p.itemId === id)!.layout);
    expect(res).toMatchObject({ seasons: 2, episodes: 10, unmatched: 0 });
    const d = await getItem(db, id);
    expect(d?.seasons?.map((s) => [s.title, s.episodes.length])).toEqual([
      ["Арка 1", 4],
      [null, 6],
    ]);
    expect((await listPendingSeasonOverrides(db)).map((p) => p.itemId)).not.toContain(id);
  });
});
