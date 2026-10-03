/** Релиз сезона AniLibria → сезон N TMDb-тайтла, повторный импорт по алиасу. */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  absorbAnilibriaSeason,
  episodes,
  findAnimeSeasonPairs,
  items,
  media,
  type PublishIngestInput,
  parseReleaseSeason,
  publishIngest,
  seasons,
} from "../src/index";
import { createTestDb } from "./helpers";

function relEp(n: number): PublishIngestInput {
  return {
    item: { type: "anime" as const, title: "Синий оркестр 2", year: 2025, externalSource: "anilibria", externalId: "10060" },
    media: {
      episode: { seasonNumber: 1, episodeNumber: n, title: `Серия ${n}` },
      title: `Серия ${n}`,
      duration: 1400,
      sourceKey: `anilibria:10060:${n}`,
    },
    files: [],
    audios: [],
    subtitles: [],
  };
}

describe("parseReleaseSeason", () => {
  it("номер сезона из названия", () => {
    expect(parseReleaseSeason("Синий оркестр 2")).toEqual({ base: "Синий оркестр", season: 2 });
    expect(parseReleaseSeason("Ao no Orchestra 2nd Season")).toEqual({ base: "Ao no Orchestra", season: 2 });
    expect(parseReleaseSeason("Spy x Family Season 3")).toEqual({ base: "Spy x Family", season: 3 });
    expect(parseReleaseSeason("[Oshi no Ko] 3rd Season")).toEqual({ base: "[Oshi no Ko]", season: 3 });
    expect(parseReleaseSeason("Туалетный мальчик Ханако 2. Часть 2")).toBeNull();
    expect(parseReleaseSeason("Ранма 1/2 (2024) 2")).toBeNull();
    expect(parseReleaseSeason("Евангелион 3.0")).toBeNull();
    expect(parseReleaseSeason("Блич")).toBeNull();
  });
});

describe("anime-season-merge", () => {
  it("вливает релиз в сезон 2 и находит его при повторном импорте", async () => {
    const db = await createTestDb();
    const [t] = await db.insert(items).values({ type: "serial", title: "Синий оркестр", year: 2023, tmdbId: 1 }).returning();
    const tid = t!.id;
    for (const sn of [1, 2]) {
      const [s] = await db.insert(seasons).values({ itemId: tid, number: sn }).returning();
      for (let n = 1; n <= 3; n++) {
        const [e] = await db.insert(episodes).values({ seasonId: s!.id, number: n }).returning();
        await db.insert(media).values({ itemId: tid, episodeId: e!.id, title: `S${sn}E${n}` });
      }
    }
    let aid = 0;
    for (let n = 1; n <= 4; n++) aid = (await publishIngest(db, relEp(n))).itemId;

    const pairs = await findAnimeSeasonPairs(db);
    expect(pairs.map((p) => [p.anilibriaId, p.tmdbItemId, p.seasonNumber])).toEqual([[aid, tid, 2]]);
    expect(await absorbAnilibriaSeason(db, aid, tid, 2)).toBe(4);

    const rows = async () =>
      (
        await db.execute<{ s: number; n: number; key: string | null }>(sql`
        select s.number as s, e.number as n, max(m.source_key) as key
        from episodes e join seasons s on s.id = e.season_id left join media m on m.episode_id = e.id
        where s.item_id = ${tid} group by 1, 2 order by 1, 2`)
      ).rows.map((r) => `${r.s}:${r.n}:${r.key ?? "-"}`);
    expect(await rows()).toEqual([
      "1:1:-",
      "1:2:-",
      "1:3:-",
      "2:1:anilibria:10060:1",
      "2:2:anilibria:10060:2",
      "2:3:anilibria:10060:3",
      "2:4:anilibria:10060:4",
    ]);

    // Повторный импорт + серия 5 → S2E5, без новой карточки и дублей media.
    for (let n = 1; n <= 5; n++) await publishIngest(db, relEp(n));
    expect((await db.select().from(items)).length).toBe(1);
    expect((await db.select().from(media)).length).toBe(8);
    expect((await rows()).at(-1)).toBe("2:5:anilibria:10060:5");
  });
});
