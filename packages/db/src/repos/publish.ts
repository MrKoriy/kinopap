/**
 * Публикация ingest-результата в каталог: item → media → файлы/аудио/субтитры.
 * Вся запись идёт через слой @zal/db, чтобы API и worker делили одну логику.
 */
import { and, eq } from "drizzle-orm";
import type { AudioDubType, ItemType } from "@zal/api-client";
import type { Db } from "../db";
import {
  audioTracks,
  countries,
  itemCountries,
  itemGenres,
  items,
  media,
  mediaFiles,
  genres,
  seasons,
  episodes,
  subtitles,
  type SpriteMeta,
} from "../schema/index";

export interface PublishItemDraft {
  type: ItemType;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  plot?: string | null;
  runtimeAvg?: number | null;
  runtimeTotal?: number | null;
  quality?: number | null;
  langs?: number;
  hasAc3?: boolean;
}

export interface PublishFile {
  quality: string;
  qualityId: number;
  width: number;
  height: number;
  codec: string;
  bitrate?: number | null;
  sizeBytes?: number | null;
  fileKey: string;
  hlsKey?: string | null;
}

export interface PublishAudio {
  trackIndex: number;
  codec: string;
  channels: number;
  lang: string;
  dubType: AudioDubType;
  authorTitle?: string | null;
  authorShortTitle?: string | null;
}

export interface PublishSubtitle {
  lang: string;
  shiftMs?: number;
  embed: boolean;
  fileKey?: string | null;
  title?: string | null;
}

export interface PublishEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title?: string | null;
}

export interface PublishIngestInput {
  item: PublishItemDraft;
  media: {
    title?: string | null;
    duration: number;
    thumbnailUrl?: string | null;
    posterKey?: string | null;
    spriteKey?: string | null;
    spriteMeta?: SpriteMeta | null;
    partNumber?: number;
    episode?: PublishEpisode | null;
  };
  files: PublishFile[];
  audios: PublishAudio[];
  subtitles: PublishSubtitle[];
}

export interface PublishResult {
  itemId: number;
  mediaId: number;
}

/** Ищем существующий item (title+year+type), иначе создаём — без дублей. */
export async function upsertItem(
  db: Db,
  draft: PublishItemDraft,
): Promise<number> {
  const existing = await db
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.type, draft.type),
        eq(items.title, draft.title),
        draft.year != null ? eq(items.year, draft.year) : undefined,
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [row] = await db
    .insert(items)
    .values({
      type: draft.type,
      title: draft.title,
      originalTitle: draft.originalTitle ?? null,
      year: draft.year ?? null,
      plot: draft.plot ?? null,
      runtimeAvg: draft.runtimeAvg ?? null,
      runtimeTotal: draft.runtimeTotal ?? null,
      quality: draft.quality ?? null,
      langs: draft.langs ?? 1,
      hasAc3: draft.hasAc3 ?? false,
    })
    .returning({ id: items.id });
  return row!.id;
}

/** Полная публикация: item (upsert) → media (+сезон/эпизод) → файлы/аудио/субтитры. */
export async function publishIngest(
  db: Db,
  input: PublishIngestInput,
): Promise<PublishResult> {
  const itemId = await upsertItem(db, input.item);

  let episodeId: number | null = null;
  if (input.media.episode) {
    const ep = input.media.episode;
    const [season] = await db
      .insert(seasons)
      .values({ itemId, number: ep.seasonNumber })
      .onConflictDoNothing({
        target: [seasons.itemId, seasons.number],
      })
      .returning({ id: seasons.id });
    const seasonId =
      season?.id ??
      (
        await db
          .select({ id: seasons.id })
          .from(seasons)
          .where(and(eq(seasons.itemId, itemId), eq(seasons.number, ep.seasonNumber)))
          .limit(1)
      )[0]!.id;

    const [episode] = await db
      .insert(episodes)
      .values({
        seasonId,
        number: ep.episodeNumber,
        title: ep.title ?? null,
        runtime: input.media.duration,
      })
      .onConflictDoNothing({ target: [episodes.seasonId, episodes.number] })
      .returning({ id: episodes.id });
    episodeId =
      episode?.id ??
      (
        await db
          .select({ id: episodes.id })
          .from(episodes)
          .where(and(eq(episodes.seasonId, seasonId), eq(episodes.number, ep.episodeNumber)))
          .limit(1)
      )[0]!.id;
  }

  const [mediaRow] = await db
    .insert(media)
    .values({
      itemId,
      episodeId,
      partNumber: input.media.partNumber ?? 1,
      title: input.media.title ?? null,
      thumbnailUrl: input.media.thumbnailUrl ?? null,
      runtime: input.media.duration,
      posterKey: input.media.posterKey ?? null,
      spriteKey: input.media.spriteKey ?? null,
      spriteMeta: input.media.spriteMeta ?? null,
    })
    .returning({ id: media.id });
  const mediaId = mediaRow!.id;

  if (input.files.length) {
    await db.insert(mediaFiles).values(
      input.files.map((f) => ({
        mediaId,
        quality: f.quality,
        qualityId: f.qualityId,
        width: f.width,
        height: f.height,
        codec: f.codec,
        bitrate: f.bitrate ?? null,
        sizeBytes: f.sizeBytes ?? null,
        fileKey: f.fileKey,
        hlsKey: f.hlsKey ?? null,
      })),
    );
  }
  if (input.audios.length) {
    await db.insert(audioTracks).values(
      input.audios.map((a) => ({
        mediaId,
        trackIndex: a.trackIndex,
        codec: a.codec,
        channels: a.channels,
        lang: a.lang,
        dubType: a.dubType,
        authorTitle: a.authorTitle ?? null,
        authorShortTitle: a.authorShortTitle ?? null,
      })),
    );
  }
  if (input.subtitles.length) {
    await db.insert(subtitles).values(
      input.subtitles.map((s) => ({
        mediaId,
        lang: s.lang,
        shiftMs: s.shiftMs ?? 0,
        embed: s.embed,
        title: s.title ?? null,
        fileKey: s.fileKey ?? null,
      })),
    );
  }

  return { itemId, mediaId };
}

export interface Enrichment {
  plot?: string | null;
  originalTitle?: string | null;
  year?: number | null;
  tmdbId?: number | null;
  tmdbRating?: number | null;
  tmdbVotes?: number | null;
  posterSmall?: string | null;
  posterMedium?: string | null;
  posterBig?: string | null;
  trailerUrl?: string | null;
  genres?: string[];
  countries?: string[];
}

/** Дозапись метаданных (TMDb) в уже опубликованный item. */
export async function applyEnrichment(
  db: Db,
  itemId: number,
  e: Enrichment,
): Promise<void> {
  await db
    .update(items)
    .set({
      ...(e.plot !== undefined ? { plot: e.plot } : {}),
      ...(e.originalTitle !== undefined ? { originalTitle: e.originalTitle } : {}),
      ...(e.year !== undefined ? { year: e.year } : {}),
      ...(e.tmdbId !== undefined ? { tmdbId: e.tmdbId } : {}),
      ...(e.tmdbRating !== undefined ? { tmdbRating: e.tmdbRating } : {}),
      ...(e.tmdbVotes !== undefined ? { tmdbVotes: e.tmdbVotes } : {}),
      ...(e.posterSmall !== undefined ? { posterSmall: e.posterSmall } : {}),
      ...(e.posterMedium !== undefined ? { posterMedium: e.posterMedium } : {}),
      ...(e.posterBig !== undefined ? { posterBig: e.posterBig } : {}),
      ...(e.trailerUrl !== undefined ? { trailerUrl: e.trailerUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(items.id, itemId));

  for (const title of e.genres ?? []) {
    const [g] = await db
      .insert(genres)
      .values({ type: "movie", title })
      .onConflictDoNothing({ target: [genres.type, genres.title] })
      .returning({ id: genres.id });
    const genreId =
      g?.id ??
      (await db.select({ id: genres.id }).from(genres).where(eq(genres.title, title)).limit(1))[0]
        ?.id;
    if (genreId) {
      await db
        .insert(itemGenres)
        .values({ itemId, genreId })
        .onConflictDoNothing({ target: [itemGenres.itemId, itemGenres.genreId] });
    }
  }

  for (const title of e.countries ?? []) {
    const [c] = await db
      .insert(countries)
      .values({ title })
      .onConflictDoNothing({ target: [countries.title] })
      .returning({ id: countries.id });
    const countryId =
      c?.id ??
      (await db.select({ id: countries.id }).from(countries).where(eq(countries.title, title)).limit(1))[0]
        ?.id;
    if (countryId) {
      await db
        .insert(itemCountries)
        .values({ itemId, countryId })
        .onConflictDoNothing({ target: [itemCountries.itemId, itemCountries.countryId] });
    }
  }
}
