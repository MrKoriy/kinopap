import type { Db } from "@zal/db";
import {
  audioTracks,
  countries,
  createInvite,
  createUser,
  episodes,
  findUserByEmail,
  genres,
  hashPassword,
  itemCountries,
  itemGenres,
  itemPeople,
  items,
  media,
  mediaFiles,
  people,
  seasons,
  subtitles,
} from "@zal/db";

export interface ApiFixtureIds {
  genre: number;
  country: number;
  movie: number;
  serial: number;
  movieMedia: number;
  episodeMedia: number;
}

/** Компактные фикстуры: фильм с media и сериал с эпизодом. */
export async function makeFixtures(db: Db): Promise<ApiFixtureIds> {
  const [genre] = await db
    .insert(genres)
    .values({ type: "movie", title: "Фантастика" })
    .returning();
  const [country] = await db.insert(countries).values({ title: "США" }).returning();

  const [movie] = await db
    .insert(items)
    .values({
      type: "movie",
      title: "Матрица",
      originalTitle: "The Matrix",
      year: 1999,
      rating: 8.7,
      views: 10,
      quality: 1080,
    })
    .returning();
  const [serial] = await db
    .insert(items)
    .values({
      type: "serial",
      title: "Игра престолов",
      year: 2011,
      rating: 9.0,
      views: 100,
      finished: true,
    })
    .returning();

  await db.insert(itemGenres).values([
    { itemId: movie.id, genreId: genre!.id },
    { itemId: serial.id, genreId: genre!.id },
  ]);
  await db
    .insert(itemCountries)
    .values({ itemId: movie.id, countryId: country!.id });

  const [person] = await db.insert(people).values({ name: "Киану Ривз" }).returning();
  await db.insert(itemPeople).values([
    { itemId: movie.id, personId: person!.id, role: "actor" },
    { itemId: serial.id, personId: person!.id, role: "actor" },
  ]);

  const [movieMedia] = await db
    .insert(media)
    .values({ itemId: movie.id, runtime: 136 })
    .returning();
  await db.insert(mediaFiles).values({
    mediaId: movieMedia!.id,
    quality: "1080p",
    qualityId: 3,
    width: 1920,
    height: 1080,
    fileKey: "matrix/1080.mp4",
    hlsKey: "matrix/1080/index.m3u8",
  });
  await db.insert(audioTracks).values({
    mediaId: movieMedia!.id,
    trackIndex: 1,
    lang: "rus",
    dubType: "mvo",
    authorTitle: "Видеосервис",
  });
  await db.insert(subtitles).values({
    mediaId: movieMedia!.id,
    lang: "eng",
    embed: true,
    fileKey: "matrix/eng.srt",
  });

  const [season] = await db
    .insert(seasons)
    .values({ itemId: serial.id, number: 1 })
    .returning();
  const [episode] = await db
    .insert(episodes)
    .values({ seasonId: season!.id, number: 1, title: "Зима близко", runtime: 62 })
    .returning();
  const [episodeMedia] = await db
    .insert(media)
    .values({ itemId: serial.id, episodeId: episode!.id, runtime: 62 })
    .returning();

  return {
    genre: genre!.id,
    country: country!.id,
    movie: movie.id,
    serial: serial.id,
    movieMedia: movieMedia!.id,
    episodeMedia: episodeMedia!.id,
  };
}

/** Owner + новый инвайт для тестов регистрации (owner создаётся один раз). */
export async function makeOwnerWithInvite(db: Db): Promise<{ invite: string }> {
  let owner = await findUserByEmail(db, "owner@zal.local");
  if (!owner) {
    owner = await createUser(db, {
      email: "owner@zal.local",
      passwordHash: await hashPassword("owner-password-1"),
      name: "Owner",
      role: "owner",
    });
  }
  const invite = await createInvite(db, { createdBy: owner.id, maxUses: 1 });
  return { invite: invite.code };
}
