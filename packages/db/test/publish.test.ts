/**
 * Публикация ингеста: фолбэк-постер (сгенерированный кадр) попадает в карточку
 * тайтла, но не перебивает уже имеющиеся постеры (например из обогащения).
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { items, publishIngest } from "../src/index";
import { createTestDb } from "./helpers";

const POSTER = "http://localhost:9000/zal-media/ingest/1-film/poster.jpg";

function draft(title: string, poster = true) {
  return {
    item: {
      type: "movie" as const,
      title,
      year: 2026,
      ...(poster
        ? { posterSmall: POSTER, posterMedium: POSTER, posterBig: POSTER }
        : {}),
    },
    media: { title, duration: 12, posterKey: "ingest/1-film/poster.jpg" },
    files: [
      {
        quality: "720p",
        qualityId: 2,
        width: 1280,
        height: 720,
        codec: "h264",
        fileKey: "ingest/1-film/720p/index.m3u8",
        hlsKey: "ingest/1-film/master.m3u8",
      },
    ],
    audios: [],
    subtitles: [],
  };
}

describe("publish: постеры тайтла", () => {
  it("заполняет постеры из ингеста, когда их не было", async () => {
    const db = await createTestDb();
    const { itemId } = await publishIngest(db, draft("Новый фильм"));

    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect(row?.posterSmall).toBe(POSTER);
    expect(row?.posterMedium).toBe(POSTER);
    expect(row?.posterBig).toBe(POSTER);
  });

  it("не перебивает существующие постеры (обогащение главнее)", async () => {
    const db = await createTestDb();
    const { itemId } = await publishIngest(db, draft("Обогащённый фильм"));
    await db
      .update(items)
      .set({ posterMedium: "https://image.tmdb.org/t/p/w500/p.jpg" })
      .where(eq(items.id, itemId));

    // Повторный ингест (вторая часть/эпизод) не должен затирать артворки.
    await publishIngest(db, draft("Обогащённый фильм"));

    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect(row?.posterMedium).toBe("https://image.tmdb.org/t/p/w500/p.jpg");
  });
});
