/**
 * Очередь детектора заставок и запись результата.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  episodes,
  items,
  listSeasonIntroEpisodes,
  listSeasonsForIntroDetect,
  media,
  mediaLinks,
  mediaSources,
  saveDetectedIntro,
  seasons,
} from "../src/index";
import { createTestDb, type TestDb } from "./helpers";

let db: TestDb;

const file = (n: number) => ({
  quality: "1080p",
  qualityId: 3,
  width: 1920,
  height: 1080,
  codec: "h264",
  bitrate: null,
  sizeBytes: null,
  urls: { http: `http://ts/stream?link=x&index=${n}&play`, hls: null },
});

async function serialWithSources(title: string, opts: { external?: string; eps: number }) {
  const [it] = await db
    .insert(items)
    .values({ type: "serial", title, externalSource: opts.external ?? null, externalId: opts.external ? title : null, views: 10 })
    .returning();
  const [s] = await db.insert(seasons).values({ itemId: it!.id, number: 1 }).returning();
  const mediaIds: number[] = [];
  for (let n = 1; n <= opts.eps; n++) {
    const [e] = await db.insert(episodes).values({ seasonId: s!.id, number: n }).returning();
    const [m] = await db.insert(media).values({ itemId: it!.id, episodeId: e!.id }).returning();
    await db.insert(mediaSources).values({
      itemId: it!.id,
      mediaId: m!.id,
      files: [file(n)],
      audios: [],
      warm: { hash: "abc", fileIndex: n, magnet: "magnet:?xt=urn:btih:abc", title },
    });
    mediaIds.push(m!.id);
  }
  return { itemId: it!.id, seasonId: s!.id, mediaIds };
}

beforeAll(async () => {
  db = await createTestDb();
});

describe("детектор заставок: очередь", () => {
  it("берёт сезоны с ≥2 непроверенными сериями, без AniLibria", async () => {
    const show = await serialWithSources("Сериал", { eps: 3 });
    await serialWithSources("Аниме", { eps: 3, external: "anilibria" });
    await serialWithSources("Одна серия", { eps: 1 });
    const queue = await listSeasonsForIntroDetect(db, 10);
    expect(queue.map((q) => q.title)).toEqual(["Сериал"]);

    const eps = await listSeasonIntroEpisodes(db, show.seasonId);
    expect(eps.map((e) => e.episodeNumber)).toEqual([1, 2, 3]);
    expect(eps[0]!.warm?.fileIndex).toBe(1);
    expect(eps[1]!.httpUrl).toContain("index=2");
  });

  it("пишет интро, не затирает интро релиза и доводит его до плеера", async () => {
    const show = await serialWithSources("Ещё сериал", { eps: 2 });
    const [m1, m2] = show.mediaIds as [number, number];
    await db.update(media).set({ introStartSeconds: 5, introEndSeconds: 90 }).where(eq(media.id, m2));

    await saveDetectedIntro(db, m1, { start: 12.4, end: 71.6 });
    await saveDetectedIntro(db, m2, { start: 30, end: 60 });

    const [r1] = await db.select().from(media).where(eq(media.id, m1));
    expect(r1).toMatchObject({ introStartSeconds: 12, introEndSeconds: 72, introSource: "audio" });
    expect(r1!.introCheckedAt).not.toBeNull();
    const [r2] = await db.select().from(media).where(eq(media.id, m2));
    expect(r2).toMatchObject({ introStartSeconds: 5, introEndSeconds: 90, introSource: null });
    expect(r2!.introCheckedAt).not.toBeNull();

    const links = await mediaLinks(db, show.itemId, m1, "http://media");
    expect(links?.intro).toEqual({ startSeconds: 12, endSeconds: 72 });
    // Обе серии проверены — сезон выпадает из очереди.
    const queue = await listSeasonsForIntroDetect(db, 10);
    expect(queue.map((q) => q.title)).not.toContain("Ещё сериал");
  });
});
