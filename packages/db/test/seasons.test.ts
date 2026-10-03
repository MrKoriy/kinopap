/**
 * Перестройка сезонов: серии переезжают в новые сезоны без потери media,
 * повторный импорт не плодит дубли, новые серии ongoing встают в конец.
 */
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applySeasonLayout,
  episodes,
  findEpisodeByOrig,
  flatEpisodes,
  longestSeason,
  media,
  type PublishIngestInput,
  publishIngest,
  seasons,
} from "../src/index";
import { createTestDb, type TestDb } from "./helpers";

function ep(n: number): PublishIngestInput {
  return {
    item: { type: "anime" as const, title: "Блич", externalSource: "anilibria", externalId: "77" },
    media: {
      episode: { seasonNumber: 1, episodeNumber: n, title: `Серия ${n}` },
      title: `Серия ${n}`,
      duration: 1400,
      sourceKey: `anilibria:77:${n}`,
    },
    files: [],
    audios: [],
    subtitles: [],
  };
}

async function layout(db: TestDb, itemId: number) {
  const rows = await db
    .select({ season: seasons.number, title: seasons.title, number: episodes.number, origNumber: episodes.origNumber, abs: episodes.absoluteNumber, id: episodes.id })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(eq(seasons.itemId, itemId))
    .orderBy(asc(seasons.number), asc(episodes.number));
  return rows;
}

describe("seasons: перестройка длинного сезона", () => {
  it("переносит серии по группам и сохраняет media", async () => {
    const db = await createTestDb();
    let itemId = 0;
    for (let n = 1; n <= 10; n++) itemId = (await publishIngest(db, ep(n))).itemId;
    expect(await longestSeason(db, itemId)).toBe(10);

    const mediaBefore = await db.select({ id: media.id, episodeId: media.episodeId }).from(media).where(eq(media.itemId, itemId));
    const flat = await flatEpisodes(db, itemId);
    const res = await applySeasonLayout(db, itemId, "tmdb-group:test", [
      { title: "Арка агента", episodeIds: flat.slice(0, 4).map((e) => e.id) },
      { title: null, episodeIds: flat.slice(4, 9).map((e) => e.id) },
    ]);
    // Десятая серия ни в одну группу не попала — дописана в последнюю.
    expect(res).toEqual({ seasons: 2, episodes: 10 });

    const rows = await layout(db, itemId);
    expect(rows.map((r) => `${r.season}:${r.number}`)).toEqual([
      "1:1", "1:2", "1:3", "1:4", "2:1", "2:2", "2:3", "2:4", "2:5", "2:6",
    ]);
    expect(rows[0]!.title).toBe("Арка агента");
    expect(rows[5]!.origNumber).toBe(6);
    expect(rows[5]!.abs).toBe(6);

    const mediaAfter = await db.select({ id: media.id, episodeId: media.episodeId }).from(media).where(eq(media.itemId, itemId));
    expect(mediaAfter).toEqual(mediaBefore);

    // Повторный импорт серии 7 — без дублей.
    await publishIngest(db, ep(7));
    expect((await layout(db, itemId)).length).toBe(10);

    // Новая серия ongoing — в конец последнего сезона.
    await publishIngest(db, ep(11));
    const after = await layout(db, itemId);
    expect(after.length).toBe(11);
    expect(after.at(-1)).toMatchObject({ season: 2, number: 7, origNumber: 11, abs: 11 });

    expect(await findEpisodeByOrig(db, itemId, 1, 7)).toBe(rows[6]!.id);
  });
});
