/**
 * Публикация ингеста: фолбэк-постер (сгенерированный кадр) попадает в карточку
 * тайтла, но не перебивает уже имеющиеся постеры (например из обогащения).
 */

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { items, media, type PublishIngestInput, publishIngest } from "../src/index";
import { createTestDb } from "./helpers";

const POSTER = "http://localhost:9000/zal-media/ingest/1-film/poster.jpg";

function draft(title: string, poster = true): PublishIngestInput {
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

describe("publish: качество файла", () => {
  it("отклоняет качество вне media_quality enum", async () => {
    const db = await createTestDb();
    const { itemId } = await publishIngest(db, draft("Фильм с чужим качеством"));
    const [m] = await db.select().from(media).where(eq(media.itemId, itemId));

    // Сырой SQL в обход TS-типа PublishFile: рантайм-защита — это enum
    // в БД (ровно то, что ловит кастинг миграции 0014).
    await expect(
      db.execute(
        sql`insert into media_files (media_id, quality, quality_id, width, height, codec, file_key)
            values (${m!.id}, '4k', 0, 3840, 2160, 'h264', 'ingest/x/4k/index.m3u8')`,
      ),
    ).rejects.toThrow();
  });
});
