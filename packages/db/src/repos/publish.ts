/**
 * Публикация ingest-результата в каталог: item → media → файлы/аудио/субтитры.
 * Вся запись идёт через слой @zal/db, чтобы API и worker делили одну логику.
 */

import type { AudioDubType, ItemType, Quality } from "@zal/api-client";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  audioTracks,
  countries,
  episodes,
  genres,
  itemCountries,
  itemGenres,
  items,
  media,
  mediaFiles,
  type SpriteMeta,
  seasons,
  subtitles,
} from "../schema/index";
import { findExternalAlias } from "./aliases";
import {
  appendEpisodeToLastSeason,
  findEpisodeByAbsolute,
  findEpisodeByOrig,
  itemSeasonLayout,
} from "./seasons";

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
  /**
   * Внешний источник и его id (anilibria:123). Задан — ищем item по нему
   * в первую очередь: id источника надёжнее названия (переименования,
   * дубли «Наруто» под разными языками).
   */
  externalSource?: string | null;
  externalId?: string | null;
  /**
   * Постеры-фолбэк (абсолютные URL), например сгенерированный ингестом
   * poster.jpg. Пишутся только если у тайтла постеров ещё нет — явные
   * метаданные (обогащение) их не перебивают.
   */
  posterSmall?: string | null;
  posterMedium?: string | null;
  posterBig?: string | null;
}

export interface PublishFile {
  quality: Quality;
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
  /** Ключ плейлиста аудио-рендitions в HLS-мастере. */
  fileKey?: string | null;
  /** Ключ персонального мастера дубляжа (видео + одна аудио-группа). */
  masterKey?: string | null;
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
    /** Ключ источника: тот же ref → обновляем существующую media, не дублируем. */
    sourceKey?: string | null;
    /** Маркер интро из источника (AniLibria): кнопка «пропустить». */
    introStartSeconds?: number | null;
    introEndSeconds?: number | null;
  };
  files: PublishFile[];
  audios: PublishAudio[];
  subtitles: PublishSubtitle[];
}

export interface PublishResult {
  itemId: number;
  mediaId: number;
}

/** Ищем существующий item иначе создаём — без дублей.
 * Приоритет: внешний id (id источника точнее названия) → (title, year[, type]). */
export async function upsertItem(
  db: Db,
  draft: PublishItemDraft,
): Promise<number> {
  const empty = (posterSmall: string | null, posterMedium: string | null, posterBig: string | null) =>
    !posterSmall && !posterMedium && !posterBig;

  // 1. Уже знаем этот внешний id — переиспользуем строку, чиним пустое.
  if (draft.externalSource && draft.externalId) {
    const byExternal = await db
      .select({
        id: items.id,
        type: items.type,
        title: items.title,
        posterSmall: items.posterSmall,
        posterMedium: items.posterMedium,
        posterBig: items.posterBig,
      })
      .from(items)
      .where(
        and(
          eq(items.externalSource, draft.externalSource),
          eq(items.externalId, draft.externalId),
        ),
      )
      .limit(1);
    const ext = byExternal[0];
    if (ext) {
      if (
        empty(ext.posterSmall, ext.posterMedium, ext.posterBig) &&
        draft.posterMedium
      ) {
        await db
          .update(items)
          .set({
            posterSmall: draft.posterSmall ?? draft.posterMedium,
            posterMedium: draft.posterMedium,
            posterBig: draft.posterBig ?? draft.posterMedium,
          })
          .where(eq(items.id, ext.id));
      }
      return ext.id;
    }
    // Релиз влит в сезон другого тайтла («Магическая битва 2» → сезон 2).
    const alias = await findExternalAlias(db, draft.externalSource, draft.externalId);
    if (alias) return alias.itemId;
  }

  const existing = await db
    .select({
      id: items.id,
      posterSmall: items.posterSmall,
      posterMedium: items.posterMedium,
      posterBig: items.posterBig,
      externalSource: items.externalSource,
      externalId: items.externalId,
    })
    .from(items)
    .where(
      and(
        eq(items.type, draft.type),
        eq(items.title, draft.title),
        draft.year != null ? eq(items.year, draft.year) : undefined,
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found) {
    // Постеры ингеста — только фолбэк: пустые поля заполняем, чужие не трогаем.
    if (empty(found.posterSmall, found.posterMedium, found.posterBig) && draft.posterMedium) {
      await db
        .update(items)
        .set({
          posterSmall: draft.posterSmall ?? draft.posterMedium,
          posterMedium: draft.posterMedium,
          posterBig: draft.posterBig ?? draft.posterMedium,
        })
        .where(eq(items.id, found.id));
    }
    // Запись уже существует, но без внешнего id (сида/прошлые импорты) —
    // проставляем его, чтобы следующий импорт нашёл её по источнику.
    if (draft.externalSource && draft.externalId) {
      await db
        .update(items)
        .set({ externalSource: draft.externalSource, externalId: draft.externalId })
        .where(eq(items.id, found.id));
    }
    return found.id;
  }

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
      posterSmall: draft.posterSmall ?? draft.posterMedium ?? null,
      posterMedium: draft.posterMedium ?? draft.posterSmall ?? null,
      posterBig: draft.posterBig ?? draft.posterMedium ?? null,
      externalSource: draft.externalSource ?? null,
      externalId: draft.externalId ?? null,
    })
    .onConflictDoNothing({ target: [items.externalSource, items.externalId] })
    .returning({ id: items.id });
  if (row) return row.id;

  // Гонка двух ingest'ов одного источника: второй берёт уже вставленную строку.
  const [raced] = await db
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.externalSource, draft.externalSource ?? ""),
        eq(items.externalId, draft.externalId ?? ""),
      ),
    )
    .limit(1);
  return raced!.id;
}

/** Полная публикация: item (upsert) → media (+сезон/эпизод) → файлы/аудио/субтитры.
 * Одна транзакция: падение посередине больше не оставляет в каталоге
 * media без файлов / item без media. Дедуп media по (item, sourceKey):
 * повторный ingest того же источника обновляет существующую запись —
 * файлы/аудио/субтитры заменяются, mediaId сохраняется. */
export async function publishIngest(
  db: Db,
  input: PublishIngestInput,
): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    const itemId = await upsertItem(tx, input.item);

    let episodeId: number | null = null;
    // Повторный импорт той же серии: эпизод уже есть — берём его как есть.
    // После перестройки сезонов «S1E245» источника живёт в «Сезоне 12»,
    // и поиск по season/number создал бы дубль в первом сезоне.
    let reuseEpisode = false;
    if (input.media.episode && input.media.sourceKey) {
      const [prev] = await tx
        .select({ episodeId: media.episodeId })
        .from(media)
        .where(and(eq(media.itemId, itemId), eq(media.sourceKey, input.media.sourceKey)))
        .limit(1);
      if (prev?.episodeId != null) {
        episodeId = prev.episodeId;
        reuseEpisode = true;
      }
    }
    // Релиз влит в сезон N тайтла: его серия k — это SNEk, а не сквозная k.
    const aliasSeason =
      input.item.externalSource && input.item.externalId && input.media.episode
        ? ((await findExternalAlias(tx as unknown as Db, input.item.externalSource, input.item.externalId))
            ?.seasonNumber ?? null)
        : null;
    if (aliasSeason != null && input.media.episode) {
      input = { ...input, media: { ...input.media, episode: { ...input.media.episode, seasonNumber: aliasSeason } } };
    }
    if (input.media.episode && !reuseEpisode) {
      const ep = input.media.episode;
      const txDb = tx as unknown as Db;
      // Релиз AniLibria, влитый в TMDb-тайтл: серия k — это k-я по сквозному
      // номеру, а не S1Ek (у TMDb сезонов может быть несколько).
      const byAbsolute = input.media.sourceKey?.startsWith("anilibria:") && aliasSeason == null
        ? await findEpisodeByAbsolute(txDb, itemId, ep.episodeNumber)
        : null;
      const byOrig =
        byAbsolute ?? (await findEpisodeByOrig(txDb, itemId, ep.seasonNumber, ep.episodeNumber));
      if (byOrig != null) {
        episodeId = byOrig;
      } else if (isRegroupedLayout(await itemSeasonLayout(txDb, itemId))) {
        episodeId = await appendEpisodeToLastSeason(txDb, itemId, {
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          title: ep.title ?? null,
          runtime: input.media.duration,
        });
      }
    }
    if (input.media.episode && episodeId == null) {
      const ep = input.media.episode;
      const [season] = await tx
        .insert(seasons)
        .values({ itemId, number: ep.seasonNumber })
        .onConflictDoNothing({
          target: [seasons.itemId, seasons.number],
        })
        .returning({ id: seasons.id });
      const seasonId =
        season?.id ??
        (
          await tx
            .select({ id: seasons.id })
            .from(seasons)
            .where(and(eq(seasons.itemId, itemId), eq(seasons.number, ep.seasonNumber)))
            .limit(1)
        )[0]!.id;

      const [episode] = await tx
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
          await tx
            .select({ id: episodes.id })
            .from(episodes)
            .where(and(eq(episodes.seasonId, seasonId), eq(episodes.number, ep.episodeNumber)))
            .limit(1)
        )[0]!.id;
    }

    // Дедуп по источнику: обновляем существующую media вместо новой записи.
    let mediaId: number | null = null;
    if (input.media.sourceKey) {
      const existing = await tx
        .select({ id: media.id })
        .from(media)
        .where(
          and(eq(media.itemId, itemId), eq(media.sourceKey, input.media.sourceKey)),
        )
        .limit(1);
      // Нет media с этим ключом, но у серии есть плейсхолдер без источника
      // (гидрация TMDb) — усыновляем его: одна media на серию, прогресс цел.
      if (!existing[0] && episodeId != null) {
        const [placeholder] = await tx
          .select({ id: media.id })
          .from(media)
          .where(and(eq(media.episodeId, episodeId), isNull(media.sourceKey)))
          .limit(1);
        if (placeholder) {
          await tx
            .update(media)
            .set({ sourceKey: input.media.sourceKey })
            .where(eq(media.id, placeholder.id));
          existing.push(placeholder);
        }
      }
      if (existing[0]) {
        mediaId = existing[0].id;
        await tx
          .update(media)
          .set({
            episodeId,
            partNumber: input.media.partNumber ?? 1,
            title: input.media.title ?? null,
            thumbnailUrl: input.media.thumbnailUrl ?? null,
            runtime: input.media.duration,
            posterKey: input.media.posterKey ?? null,
            spriteKey: input.media.spriteKey ?? null,
            spriteMeta: input.media.spriteMeta ?? null,
            introStartSeconds: input.media.introStartSeconds ?? null,
            introEndSeconds: input.media.introEndSeconds ?? null,
          })
          .where(eq(media.id, mediaId));
        // Старые файлы/дорожки/субтитры заменяются новыми (каскад не годится —
        // media жива). Сироты на диске подчистит GC воркера.
        await tx.delete(mediaFiles).where(eq(mediaFiles.mediaId, mediaId));
        await tx.delete(audioTracks).where(eq(audioTracks.mediaId, mediaId));
        await tx.delete(subtitles).where(eq(subtitles.mediaId, mediaId));
      }
    }

    if (mediaId == null) {
      const [mediaRow] = await tx
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
          sourceKey: input.media.sourceKey ?? null,
          introStartSeconds: input.media.introStartSeconds ?? null,
          introEndSeconds: input.media.introEndSeconds ?? null,
        })
        .returning({ id: media.id });
      mediaId = mediaRow!.id;
    }

    if (input.files.length) {
      await tx.insert(mediaFiles).values(
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
      await tx.insert(audioTracks).values(
        input.audios.map((a) => ({
          mediaId,
          trackIndex: a.trackIndex,
          codec: a.codec,
          channels: a.channels,
          lang: a.lang,
          dubType: a.dubType,
          authorTitle: a.authorTitle ?? null,
          authorShortTitle: a.authorShortTitle ?? null,
          fileKey: a.fileKey ?? null,
          masterKey: a.masterKey ?? null,
        })),
      );
    }
    if (input.subtitles.length) {
      await tx.insert(subtitles).values(
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
  });
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
  /** YouTube-ключ ролика (TMDb videos[].key) — из него строим embed. */
  trailerId?: string | null;
  trailerUrl?: string | null;
  genres?: string[];
  countries?: string[];
}

/** Дозапись метаданных (TMDb) в уже опубликованный item.
 * Жанры/страны — пачками (insert onConflictDoNothing + один select
 * недостающих), без N+1; всё вместе с апдейтом item — в транзакции. */
export async function applyEnrichment(
  db: Db,
  itemId: number,
  e: Enrichment,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
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
        // Постер сменился — свои нарезки устарели: сбрасываем, воркер нарежет заново.
        ...(e.posterBig !== undefined
          ? {
              posterHash: sql`case when ${items.posterBig} is distinct from ${e.posterBig} then null else ${items.posterHash} end`,
              imagesCheckedAt: sql`case when ${items.posterBig} is distinct from ${e.posterBig} then null else ${items.imagesCheckedAt} end`,
            }
          : {}),
        ...(e.trailerId !== undefined ? { trailerId: e.trailerId } : {}),
        ...(e.trailerUrl !== undefined ? { trailerUrl: e.trailerUrl } : {}),
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId));

    const genreTitles = [...new Set(e.genres ?? [])];
    if (genreTitles.length > 0) {
      await tx
        .insert(genres)
        .values(genreTitles.map((title) => ({ type: "movie" as const, title })))
        .onConflictDoNothing({ target: [genres.type, genres.title] });
      const genreRows = await tx
        .select({ id: genres.id })
        .from(genres)
        .where(and(eq(genres.type, "movie"), inArray(genres.title, genreTitles)));
      if (genreRows.length > 0) {
        await tx
          .insert(itemGenres)
          .values(genreRows.map((r) => ({ itemId, genreId: r.id })))
          .onConflictDoNothing({ target: [itemGenres.itemId, itemGenres.genreId] });
      }
    }

    const countryTitles = [...new Set(e.countries ?? [])];
    if (countryTitles.length > 0) {
      await tx
        .insert(countries)
        .values(countryTitles.map((title) => ({ title })))
        .onConflictDoNothing({ target: [countries.title] });
      const countryRows = await tx
        .select({ id: countries.id })
        .from(countries)
        .where(inArray(countries.title, countryTitles));
      if (countryRows.length > 0) {
        await tx
          .insert(itemCountries)
          .values(countryRows.map((r) => ({ itemId, countryId: r.id })))
          .onConflictDoNothing({ target: [itemCountries.itemId, itemCountries.countryId] });
      }
    }
  });
}

/** Перестроенная раскладка (эпизод-группа TMDb или ручная): новые серии — в конец. */
function isRegroupedLayout(layout: string | null | undefined): boolean {
  return !!layout && (layout.startsWith("tmdb-group:") || layout === "override");
}
