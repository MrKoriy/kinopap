/**
 * Тестовая БД: PGlite (Postgres в памяти) + реальные миграции drizzle.
 * Ничего не требует снаружи — ни Docker, ни сети.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsDir } from "../src/db";
import * as schema from "../src/schema/index";

export type TestDb = PgliteDatabase<typeof schema>;

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsDir });
  return db;
}

export interface FixtureIds {
  genreScifi: number;
  genreDrama: number;
  countryUsa: number;
  matrix: number;
  reloaded: number;
  got: number;
  keanu: number;
  wachowski: number;
}

/** Каталожные фикстуры: 2 фильма + 1 сериал с эпизодами и media. */
export async function seedFixtures(db: TestDb): Promise<FixtureIds> {
  const [genreScifi] = await db
    .insert(schema.genres)
    .values({ type: "movie", title: "Фантастика" })
    .returning();
  const [genreDrama] = await db
    .insert(schema.genres)
    .values({ type: "movie", title: "Драма" })
    .returning();
  const [countryUsa] = await db
    .insert(schema.countries)
    .values({ title: "США" })
    .returning();

  const [matrix] = await db
    .insert(schema.items)
    .values({
      type: "movie",
      title: "Матрица",
      originalTitle: "The Matrix",
      year: 1999,
      plot: "Хакер узнаёт правду о мире",
      runtimeAvg: 136,
      runtimeTotal: 136,
      quality: 1080,
      rating: 8.7,
      views: 10,
      imdbRating: 8.7,
      posterMedium: "matrix-m.jpg",
    })
    .returning();
  const [reloaded] = await db
    .insert(schema.items)
    .values({
      type: "movie",
      title: "Матрица: Перезагрузка",
      originalTitle: "The Matrix Reloaded",
      year: 2003,
      runtimeAvg: 138,
      runtimeTotal: 138,
      quality: 1080,
      rating: 7.0,
      views: 5,
    })
    .returning();
  const [got] = await db
    .insert(schema.items)
    .values({
      type: "serial",
      title: "Игра престолов",
      originalTitle: "Game of Thrones",
      year: 2011,
      finished: true,
      rating: 9.0,
      views: 100,
    })
    .returning();

  await db.insert(schema.itemGenres).values([
    { itemId: matrix.id, genreId: genreScifi!.id },
    { itemId: reloaded.id, genreId: genreScifi!.id },
    { itemId: got.id, genreId: genreDrama!.id },
  ]);
  await db
    .insert(schema.itemCountries)
    .values({ itemId: matrix.id, countryId: countryUsa!.id });

  const [keanu] = await db
    .insert(schema.people)
    .values({ name: "Киану Ривз" })
    .returning();
  const [wachowski] = await db
    .insert(schema.people)
    .values({ name: "Вачовски" })
    .returning();
  await db.insert(schema.itemPeople).values([
    { itemId: matrix.id, personId: keanu!.id, role: "actor", characterName: "Нео" },
    { itemId: matrix.id, personId: wachowski!.id, role: "director" },
    { itemId: reloaded.id, personId: keanu!.id, role: "actor" },
    { itemId: reloaded.id, personId: wachowski!.id, role: "director" },
  ]);

  // Media для фильма: лестница качеств + аудио MVO + субтитры.
  const [matrixMedia] = await db
    .insert(schema.media)
    .values({ itemId: matrix.id, title: "Матрица", runtime: 136 })
    .returning();
  await db.insert(schema.mediaFiles).values([
    {
      mediaId: matrixMedia!.id,
      quality: "1080p",
      qualityId: 3,
      width: 1920,
      height: 1080,
      fileKey: "matrix/1080.mp4",
      hlsKey: "matrix/1080/index.m3u8",
    },
    {
      mediaId: matrixMedia!.id,
      quality: "720p",
      qualityId: 2,
      width: 1280,
      height: 720,
      fileKey: "matrix/720.mp4",
      hlsKey: "matrix/720/index.m3u8",
    },
  ]);
  await db.insert(schema.audioTracks).values({
    mediaId: matrixMedia!.id,
    trackIndex: 1,
    codec: "aac",
    channels: 6,
    lang: "rus",
    dubType: "mvo",
    authorTitle: "Видеосервис",
    authorShortTitle: "ВС",
  });
  await db.insert(schema.subtitles).values({
    mediaId: matrixMedia!.id,
    lang: "eng",
    shiftMs: 0,
    embed: true,
    fileKey: "matrix/eng.srt",
  });

  // Сериал: 1 сезон, 2 эпизода, у каждого media с файлом.
  const [season1] = await db
    .insert(schema.seasons)
    .values({ itemId: got.id, number: 1, title: "Сезон 1" })
    .returning();
  const [ep1] = await db
    .insert(schema.episodes)
    .values({ seasonId: season1!.id, number: 1, title: "Зима близко", runtime: 62 })
    .returning();
  const [ep2] = await db
    .insert(schema.episodes)
    .values({ seasonId: season1!.id, number: 2, title: "Королевский тракт", runtime: 56 })
    .returning();
  const [ep1Media] = await db
    .insert(schema.media)
    .values({ itemId: got.id, episodeId: ep1!.id, runtime: 62 })
    .returning();
  await db.insert(schema.media).values({
    itemId: got.id,
    episodeId: ep2!.id,
    runtime: 56,
  });
  await db.insert(schema.mediaFiles).values({
    mediaId: ep1Media!.id,
    quality: "720p",
    qualityId: 2,
    width: 1280,
    height: 720,
    fileKey: "got/s01e01/720.mp4",
    hlsKey: "got/s01e01/720/index.m3u8",
  });

  return {
    genreScifi: genreScifi!.id,
    genreDrama: genreDrama!.id,
    countryUsa: countryUsa!.id,
    matrix: matrix.id,
    reloaded: reloaded.id,
    got: got.id,
    keanu: keanu!.id,
    wachowski: wachowski!.id,
  };
}
