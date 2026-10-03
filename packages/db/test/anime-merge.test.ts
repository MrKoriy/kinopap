/**
 * Склейка релиза AniLibria с TMDb-тайтлом: одна карточка, одна media на
 * серию, источник AniLibria на нужных сериях, повторный импорт без дублей.
 */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  absorbAnilibriaItem,
  episodes,
  findAnimeSourcePairs,
  items,
  media,
  type PublishIngestInput,
  publishIngest,
  seasons,
} from "../src/index";
import { createTestDb } from "./helpers";

function aniEp(n: number): PublishIngestInput {
  return {
    item: { type: "anime" as const, title: "Дандадан", year: 2024, externalSource: "anilibria", externalId: "9001" },
    media: {
      episode: { seasonNumber: 1, episodeNumber: n, title: `Серия ${n}` },
      title: `Серия ${n}`,
      duration: 1400,
      sourceKey: `anilibria:9001:${n}`,
    },
    files: [],
    audios: [],
    subtitles: [],
  };
}

describe("anime-merge: AniLibria → TMDb", () => {
  it("вливает серии по сквозному номеру и забирает внешний id", async () => {
    const db = await createTestDb();
    // TMDb: 2 сезона по 3 серии, у каждой серии плейсхолдер-media.
    const [t] = await db.insert(items).values({ type: "serial", title: "Дандадан", year: 2024, tmdbId: 240411 }).returning();
    const tid = t!.id;
    for (const sn of [1, 2]) {
      const [s] = await db.insert(seasons).values({ itemId: tid, number: sn }).returning();
      for (let n = 1; n <= 3; n++) {
        const [e] = await db.insert(episodes).values({ seasonId: s!.id, number: n }).returning();
        await db.insert(media).values({ itemId: tid, episodeId: e!.id, title: `S${sn}E${n}` });
      }
    }
    let aid = 0;
    for (let n = 1; n <= 4; n++) aid = (await publishIngest(db, aniEp(n))).itemId;

    const pairs = await findAnimeSourcePairs(db);
    expect(pairs).toEqual([
      { anilibriaId: aid, tmdbItemId: tid, title: "Дандадан", anilibriaEpisodes: 4, tmdbEpisodes: 6 },
    ]);
    expect(await absorbAnilibriaItem(db, aid, tid)).toBe(4);

    expect(await db.select().from(items).where(eq(items.id, aid))).toEqual([]);
    const [after] = await db.select().from(items).where(eq(items.id, tid));
    expect(after).toMatchObject({ type: "anime", externalSource: "anilibria", externalId: "9001" });

    const rows = await db.execute<{ s: number; n: number; key: string | null; c: number }>(sql`
      select s.number as s, e.number as n, max(m.source_key) as key, count(m.id)::int as c
      from episodes e join seasons s on s.id = e.season_id left join media m on m.episode_id = e.id
      where s.item_id = ${tid} group by s.number, e.number order by 1, 2`);
    expect(rows.rows.map((r) => `${r.s}:${r.n}:${r.key ?? "-"}:${r.c}`)).toEqual([
      "1:1:anilibria:9001:1:1",
      "1:2:anilibria:9001:2:1",
      "1:3:anilibria:9001:3:1",
      "2:1:anilibria:9001:4:1",
      "2:2:-:1",
      "2:3:-:1",
    ]);

    // Повторный импорт релиза + новая серия 5 → в S2E2, без новой карточки.
    for (let n = 1; n <= 5; n++) await publishIngest(db, aniEp(n));
    const again = await db.execute<{ c: number }>(sql`select count(*)::int as c from items`);
    expect(Number(again.rows[0]!.c)).toBe(1);
    const mediaCount = await db.execute<{ c: number }>(sql`select count(*)::int as c from media`);
    expect(Number(mediaCount.rows[0]!.c)).toBe(6);
    const s2e2 = await db.execute<{ key: string }>(sql`
      select m.source_key as key from media m join episodes e on e.id = m.episode_id
      join seasons s on s.id = e.season_id where s.number = 2 and e.number = 2`);
    expect(s2e2.rows[0]!.key).toBe("anilibria:9001:5");
  });

  it("фильм-релиз AniLibria вливается в фильм TMDb (пунктуация не мешает)", async () => {
    const db = await createTestDb();
    const [t] = await db.insert(items).values({ type: "movie", title: "Тоннель в лето, выход прощаний", year: 2022, tmdbId: 1 }).returning();
    const tid = t!.id;
    await db.insert(media).values({ itemId: tid, title: "Тоннель в лето" });
    const movieRelease: PublishIngestInput = {
      item: { type: "anime" as const, title: "Тоннель в лето — выход прощаний", year: 2022, externalSource: "anilibria", externalId: "9516" },
      media: { title: "Фильм", duration: 5000, sourceKey: "anilibria:9516:1" },
      files: [],
      audios: [],
      subtitles: [],
    };
    const aid = (await publishIngest(db, movieRelease)).itemId;
    const pairs = await findAnimeSourcePairs(db);
    expect(pairs.map((p) => [p.anilibriaId, p.tmdbItemId])).toEqual([[aid, tid]]);
    expect(await absorbAnilibriaItem(db, aid, tid)).toBe(1);
    const [after] = await db.select().from(items).where(eq(items.id, tid));
    expect(after).toMatchObject({ type: "movie", externalSource: "anilibria", externalId: "9516" });
    const ms = await db.select().from(media);
    expect(ms.map((m) => [m.itemId, m.sourceKey])).toEqual([[tid, "anilibria:9516:1"]]);
    // Повторный импорт не плодит карточку и media.
    await publishIngest(db, movieRelease);
    expect((await db.select().from(items)).length).toBe(1);
    expect((await db.select().from(media)).length).toBe(1);
  });
});
