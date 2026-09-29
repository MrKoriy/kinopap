/**
 * Zero-storage Stream Resolver.
 * Resolves media links on the fly from torrents (TorrServer + Rutor) and anime CDNs.
 */
import type { AudioTrack, MediaFile, MediaLinks, WarmRelease } from "@zal/api-client";
import { AnilibriaConnector } from "./connectors/anilibria";
import { RutorConnector, type RutorRelease } from "./connectors/rutor";
import { TorrServerConnector } from "./connectors/torrserver";

/**
 * Прогрев релиза в TorrServer. Ответ на резолв не ждёт его дольше
 * WARM_BUDGET_MS: список файлов уходит клиенту сразу, а метаданные
 * торрента (addTorrent + DHT) доехжают фоном и допишутся в кэш.
 */
interface WarmedRelease extends WarmRelease {
  /** Прямая ссылка на видеофайл (http-фолбэк без gst-транскода). */
  url: string;
}

/** Бюджет ожидания прогрева в критическом пути резолва. */
const WARM_BUDGET_MS = 2500;
/** Как долго в памяти держим завершённые прогревы (для media-tracks). */
const WARM_TTL_MS = 10 * 60 * 1000;

export interface ResolveQuery {
  itemId: number;
  mediaId: number;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  type?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /**
   * Внешний источник тайтла: для аниме (externalSource="anilibria") резолвер
   * идёт напрямую в getRelease(externalId) — точный матч релиза вместо
   * поиска по названию, который ловит одноимённые ремейки и чужие сезоны.
   */
  externalSource?: string | null;
  externalId?: string | null;
  /**
   * Тепловые метаданные из кэша: если релиз уже прогревался (в т.ч. до
   * рестарта API), ответ не ждёт addTorrent вообще — индекс файла известен.
   */
  warm?: WarmRelease | null;
}

/** Результат резолва: публичные ссылки + внутренний прогрев. */
export interface ResolvedStream extends MediaLinks {
  /** В публичный DTO не уходит — магнит-ссылки клиенту не положены. */
  warm: WarmRelease | null;
}

export class StreamResolver {
  public readonly rutor: RutorConnector;
  public readonly torrServer: TorrServerConnector;
  public readonly anilibria: AnilibriaConnector;

  /** Фоновые прогревы по паре (item, media) → их результат. */
  private readonly warms = new Map<string, { at: number; promise: Promise<WarmedRelease | null> }>();
  /** Активные gst-пробы по файлу: параллельные запросы делят одну пробу. */
  private readonly trackProbes = new Map<string, Promise<AudioTrack[]>>();

  constructor(opts?: {
    rutorBaseUrl?: string;
    torrServerBaseUrl?: string;
    torrServerPublicUrl?: string;
    anilibriaBaseUrl?: string;
  }) {
    this.rutor = new RutorConnector(opts?.rutorBaseUrl ? [opts.rutorBaseUrl] : undefined);
    this.torrServer = new TorrServerConnector(opts?.torrServerBaseUrl, opts?.torrServerPublicUrl);
    this.anilibria = new AnilibriaConnector(opts?.anilibriaBaseUrl);
  }

  /**
   * Resolves on-the-fly streaming options for a movie or episode.
   * Zero disk storage required.
   *
   * Четыре фазы: аниме-резолв (AniLibria), торрент-поиск (rutor), прогрев
   * лучшего релиза (TorrServer, в пределах бюджета), сборка files.
   */
  async resolve(query: ResolveQuery): Promise<ResolvedStream> {
    // 1. Аниме: AniLibria отдаёт готовый HLS — мгновенный старт без торрентов.
    const anime = await this.resolveAnime(query);

    // 2. Поиск торрент-релизов на rutor + скоринг под веб-стриминг.
    const releases = await this.findTorrentReleases(query);

    // 3. Прогрев лучшего релиза: тёплый кэш не ждём вовсе, новый — только
    //    в пределах бюджета (точный fileIndex доедет фоном).
    const warmed = await this.warmTopRelease(query, releases);

    // 4. Сборка files из релизов; источников нет — честный пустой список
    //    (без мёртвой заглушки stream?link=none, плеер показал бы ошибку).
    const torrentFiles = this.buildTorrentFiles(releases, warmed);

    // Аудио-дорожки НЕ резолвим здесь: gst-проба читает голову файла из
    // торрента и на холодных пирах занимает до 45с. Дорожки подтягиваются
    // лениво через tracksFor() по маршруту /items/:id/media-tracks, когда
    // плеер уже играет.

    return {
      mediaId: query.mediaId,
      itemId: query.itemId,
      files: [...anime.files, ...torrentFiles],
      audios: anime.audios,
      subtitles: [],
      posterUrl: null,
      sprites: null,
      intro: anime.intro,
      // Только 4 поля: url (прямая ссылка) — производная, в кэш не нужна.
      warm: warmed
        ? {
            hash: warmed.hash,
            fileIndex: warmed.fileIndex,
            magnet: warmed.magnet,
            title: warmed.title,
          }
        : null,
    };
  }

  /** Фаза 1: AniLibria — интро, HLS-серии и дорожка озвучки. */
  private async resolveAnime(
    query: ResolveQuery,
  ): Promise<{ files: MediaFile[]; audios: AudioTrack[]; intro: MediaLinks["intro"] }> {
    const files: MediaFile[] = [];
    const audios: AudioTrack[] = [];
    let intro: MediaLinks["intro"] = null;

    // If it's anime or contains anime keywords, try AniLibria for instant HLS
    if (query.type === "anime" || /аниме|anime/i.test(query.title)) {
      try {
        // Точный путь: тайтл импортирован из AniLibria — берём его релиз по id.
        let full: Awaited<ReturnType<AnilibriaConnector["getRelease"]>> = null;
        if (query.externalSource === "anilibria" && query.externalId) {
          const externalId = Number(query.externalId);
          if (Number.isFinite(externalId)) {
            full = await this.anilibria.getRelease(externalId);
          }
        }
        // Фолбэк (ручной тайтл / источник лежит) — поиск по названию.
        if (!full) {
          const aniReleases = await this.anilibria.search(query.title);
          if (aniReleases.length > 0) {
            full = await this.anilibria.getRelease(aniReleases[0].id);
          }
        }
        if (full && full.episodes.length > 0) {
          const targetEp =
            query.episodeNumber != null
              ? full.episodes.find((e) => e.ordinal === query.episodeNumber) ??
                full.episodes[0]
              : full.episodes[0];

          if (targetEp.introStart && targetEp.introStop) {
            intro = {
              startSeconds: targetEp.introStart,
              endSeconds: targetEp.introStop,
            };
          }

          if (targetEp.hls1080) {
            files.push({
              quality: "1080p (AniLibria)",
              qualityId: 1080,
              width: 1920,
              height: 1080,
              codec: "h264",
              bitrate: null,
              sizeBytes: null,
              urls: {
                http: targetEp.hls1080,
                hls: targetEp.hls1080,
              },
            });
          }
          if (targetEp.hls720 && !targetEp.hls1080) {
            files.push({
              quality: "720p (AniLibria)",
              qualityId: 720,
              width: 1280,
              height: 720,
              codec: "h264",
              bitrate: null,
              sizeBytes: null,
              urls: {
                http: targetEp.hls720,
                hls: targetEp.hls720,
              },
            });
          }

          audios.push({
            id: 1,
            index: 0,
            codec: "aac",
            channels: 2,
            lang: "rus",
            type: "dub",
            author: {
              title: "AniLibria",
              shortTitle: "AL",
            },
            url: null,
            masterUrl: null,
          });
        }
      } catch {
        // Fallback to torrent search
      }
    }

    return { files, audios, intro };
  }

  /** Фаза 2: поиск релизов на rutor, дедуп по хешу и скоринг. */
  private async findTorrentReleases(query: ResolveQuery): Promise<RutorRelease[]> {
    // Search torrent releases on Rutor: русский титул И оригинальный
    // параллельно. Названия франшиз расходятся: под «Форсаж» rutor держит
    // мусор, под «The Fast and the Furious» — все фильмы. Слияние по хешу.
    const cleanTitle = query.title.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim();
    const cleanOriginal = query.originalTitle?.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim();

    const searchQueries = new Set<string>();
    {
      const withYear = (t: string) => {
        if (query.seasonNumber != null && query.episodeNumber != null) {
          const s = String(query.seasonNumber).padStart(2, "0");
          const e = String(query.episodeNumber).padStart(2, "0");
          return `${t} s${s}e${e}`;
        }
        // Год в запросе сужает выдачу rutor'а и убирает лишний третий
        // раунд поиска «title + год» — минус до 4с латентности резолва.
        return query.year ? `${t} ${query.year}` : t;
      };
      if (cleanTitle) searchQueries.add(withYear(cleanTitle));
      if (cleanOriginal && cleanOriginal !== cleanTitle) {
        searchQueries.add(withYear(cleanOriginal));
      }
    }

    const byHash = new Map<string, RutorRelease>();
    const mergeReleases = (settled: PromiseSettledResult<RutorRelease[]>) => {
      if (settled.status !== "fulfilled") return;
      for (const rel of settled.value) {
        const prev = byHash.get(rel.hash);
        if (!prev || rel.seeds > prev.seeds) byHash.set(rel.hash, rel);
      }
    };

    const settled = await Promise.allSettled([...searchQueries].map((q) => this.rutor.search(q)));
    for (const r of settled) mergeReleases(r);
    let releases: RutorRelease[] = [...byHash.values()];

    // Если год не помог (релизы без года в названии) — ищем без года.
    if (releases.length === 0 && query.year) {
      const bare = [cleanTitle, cleanOriginal].filter((t): t is string => !!t);
      const bareSettled = await Promise.allSettled(
        [...new Set(bare)].map((q) => this.rutor.search(q)),
      );
      for (const r of bareSettled) mergeReleases(r);
      releases = [...byHash.values()];
    }

    // Filter out non-video releases (books, mp3s, games, etc.)
    const videoReleases = releases.filter((r) => {
      const lower = r.title.toLowerCase();
      if (/mp3|flac|fb2|epub|pdf|аудиокнига|ост|\bost\b|сборник музыки|\bpc\b|игра|game/i.test(lower))
        return false;
      return true;
    });

    // Score releases for optimal web streaming performance:
    // Prefer healthy seeders and moderate size (1.5GB - 8GB) over gigantic 70GB remuxes
    const scoredReleases = videoReleases.map((r) => {
      let score = (r.seeds ?? 0) * 10 + (r.peers ?? 0);
      const gb = (r.sizeBytes ?? 0) / (1024 * 1024 * 1024);
      if (gb >= 1.5 && gb <= 6.0) {
        score += 500; // Optimal 1080p web stream size
      } else if (gb > 6.0 && gb <= 12.0) {
        score += 250;
      } else if (gb > 35.0) {
        score -= 200; // Gigantic remuxes buffer very slowly over browser
      }
      if ((r.seeds ?? 0) === 0) {
        score -= 800; // Мёртвый релиз — последняя надежда, не выбор по умолчанию
      }
      if (/web-dl|webrip/i.test(r.title)) {
        score += 150;
      }
      // Релиз с нужным годом в названии — точно та часть франшизы.
      if (query.year && r.year === query.year) score += 100;
      return { rel: r, score };
    });

    scoredReleases.sort((a, b) => b.score - a.score);

    let viableReleases = scoredReleases.map((s) => s.rel).slice(0, 8);
    if (viableReleases.length === 0 && releases.length > 0) {
      viableReleases = releases.slice(0, 5);
    }
    return viableReleases;
  }

  /**
   * Фаза 3: прогрев лучшего релиза. Знакомый релиз (тёплый кэш) не ждём
   * вообще, новый — только в пределах бюджета: клиент получает список
   * файлов сразу, а точный fileIndex подтянется, когда метаданные доехали.
   * Раньше здесь стоял безусловный await — addTorrent + DHT добавляли
   * к каждому холодному резолву до 3с сверх поиска в rutor.
   */
  private async warmTopRelease(
    query: ResolveQuery,
    releases: RutorRelease[],
  ): Promise<WarmedRelease | null> {
    const known = query.warm ?? null;
    const best = releases[0] ?? null;

    if (known && best && known.magnet === best.magnet) {
      // Сервер TorrServer мог перезапуститься — заново приоткрываем голову
      // файла, чтобы первый сегмент не ждал DHT.
      void this.torrServer.preopenStream(known.hash, known.fileIndex).catch(() => {});
      return { ...known, url: this.torrServer.getStreamUrl(known.hash, known.fileIndex) };
    }
    if (best) {
      const pending = this.startWarm(`${query.itemId}:${query.mediaId}`, best);
      return (await budget(pending, WARM_BUDGET_MS)) ?? null;
    }
    return null;
  }

  /** Фаза 4: files из релизов — stream/http TorrServer + gst-HLS. */
  private buildTorrentFiles(
    releases: RutorRelease[],
    warmed: WarmedRelease | null,
  ): MediaFile[] {
    const files: MediaFile[] = [];
    for (const rel of releases) {
      // Generate TorrServer stream link for the magnet
      const warmHit = warmed && warmed.magnet === rel.magnet ? warmed : null;
      const streamUrl = warmHit
        ? warmHit.url
        : this.torrServer.getStreamUrlForMagnet(rel.magnet, 1);
      // HLS через gst-транскодер: звук AAC (Chrome играет), HEVC→H.264.
      // Незнакомый хеш TorrServer подтянет сам — достаточно btih из магнита.
      const hash = warmHit ? warmHit.hash : btihOf(rel.magnet);
      // На холоде индекс неизвестен (метаданные ещё едут) — gst сам
      // подтянет торрент по хешу, а неверный index подхватит ретрай плеера.
      const fileIndex = warmHit ? warmHit.fileIndex : 1;
      const hlsUrl = hash ? this.torrServer.getGstHlsUrl(hash, fileIndex) : null;
      const is4k = rel.quality.includes("4K") || rel.quality.includes("2160");
      const is1080 = rel.quality.includes("1080");

      files.push({
        quality: `${rel.quality} [${rel.size}, ${rel.seeds} seeds]`,
        qualityId: is4k ? 2160 : is1080 ? 1080 : 720,
        width: is4k ? 3840 : is1080 ? 1920 : 1280,
        height: is4k ? 2160 : is1080 ? 1080 : 720,
        codec: is4k ? "hevc" : "h264",
        bitrate: null,
        sizeBytes: rel.sizeBytes,
        urls: {
          http: streamUrl,
          hls: hlsUrl, // gst-транскодер: AAC-звук для браузеров
        },
      });
    }
    return files;
  }

  /**
   * Прогрев этой пары (item, media): дедуплицирует параллельные вызовы и
   * отдаёт результат, когда фоновый прогрев из resolve() доедет. Нужен
   * роуту media-tracks — ответ клиенту он не задерживает.
   */
  async warmFor(itemId: number, mediaId: number): Promise<WarmRelease | null> {
    const entry = this.warms.get(`${itemId}:${mediaId}`);
    if (!entry || Date.now() - entry.at > WARM_TTL_MS) return null;
    return entry.promise;
  }

  /** Запускает прогрев релиза под пару (item, media) с дедупликацией. */
  private startWarm(key: string, rel: RutorRelease | null): Promise<WarmedRelease | null> {
    if (!rel) return Promise.resolve(null);
    const existing = this.warms.get(key);
    if (existing && Date.now() - existing.at <= WARM_TTL_MS) return existing.promise;

    // Ошибки глотаем: прогрев опционален, резолв и без него отдаёт файлы.
    const promise = this.warmBestRelease(rel).catch(() => null);
    this.warms.set(key, { at: Date.now(), promise });
    if (this.warms.size > 500) {
      const cutoff = Date.now() - WARM_TTL_MS;
      for (const [k, v] of this.warms) {
        if (v.at < cutoff) this.warms.delete(k);
      }
    }
    return promise;
  }

  /**
   * Ленивые аудио-дорожки прогретого релиза: gst-проба, при неудаче —
   * самолечение (drop+re-add для зависших после рестарта торрентов).
   * Вызывается фоном уже во время воспроизведения. Одновременные запросы
   * на один файл делят одну пробу — двойная проба на холодных пирах
   * означает две паузы по 45с.
   */
  tracksFor(warm: WarmRelease): Promise<AudioTrack[]> {
    const key = `${warm.hash}:${warm.fileIndex}`;
    const existing = this.trackProbes.get(key);
    if (existing) return existing;
    const promise = this.probeTracks(warm).finally(() => {
      this.trackProbes.delete(key);
    });
    this.trackProbes.set(key, promise);
    return promise;
  }

  private async probeTracks(warm: WarmRelease): Promise<AudioTrack[]> {
    let probe = await this.torrServer.probeGst(warm.hash, warm.fileIndex);
    if (!probe) {
      // Торренты из БД после рестарта TorrServer иногда висят без данных
      // («пиры есть, куски не идут») — дропаем и пере-добавляем.
      await this.torrServer.dropTorrent(warm.hash);
      await this.torrServer.addTorrent(warm.magnet, warm.title);
      await new Promise((r) => setTimeout(r, 5000));
      probe = await this.torrServer.probeGst(warm.hash, warm.fileIndex);
    }

    const audios: AudioTrack[] = [];
    if (!probe) return audios;
    let id = 1;
    for (const pad of probe.tracks.filter((t) => t.Type === "audio")) {
      const lang = (pad.Language || "ru").slice(0, 12);
      const isOriginal = lang.startsWith("en");
      const title = pad.Title?.trim()
        ? pad.Title.slice(0, 120)
        : isOriginal
          ? "Оригинал"
          : "Дубляж";
      audios.push({
        id: id++,
        index: pad.Index,
        codec: "aac",
        channels: pad.Channels ?? 2,
        lang,
        type: isOriginal ? "original" : "dub",
        author: {
          title,
          shortTitle: title.split(/[\s(]/)[0]?.slice(0, 24) || lang,
        },
        url: null,
        masterUrl: this.torrServer.getGstHlsUrl(warm.hash, warm.fileIndex, pad.Index),
      });
    }
    return audios;
  }

  /**
   * Добавляет релиз в TorrServer (idempotent) и возвращает прямую ссылку
   * на крупнейший видеофайл торрента. null — TorrServer недоступен или
   * метаданные не подтянулись: вызывающий код откатывается на magnet-URL.
   */
  private async warmBestRelease(rel: RutorRelease | null): Promise<WarmedRelease | null> {
    if (!rel) return null;
    try {
      const added = await this.torrServer.addTorrent(rel.magnet, rel.title);
      const hash = added.hash;
      let torrent =
        added.file_stats && added.file_stats.length > 0
          ? added
          : await this.torrServer.getTorrent(hash);
      if (!torrent?.file_stats || torrent.file_stats.length === 0) {
        // Метаданные качаются через DHT — даём полторы секунды и пробуем снова.
        await new Promise((r) => setTimeout(r, 1500));
        torrent = await this.torrServer.getTorrent(hash);
      }
      const best = torrent ? this.torrServer.findBestVideoFile(torrent.file_stats) : null;
      const index = best ? best.id : 1;
      const filename = best?.path.split(/[\\/]/).pop();

      // Предоткрытие: тянем 2МБ головы файла — TorrServer подключает пиров
      // и закачивает первые куски в кэш. Транскодеру потом не ждать DHT:
      // манифест и init.mp4 собираются из тёплого кэша. Fire-and-forget.
      void this.torrServer.preopenStream(hash, index).catch(() => {});

      return {
        magnet: rel.magnet,
        hash,
        title: rel.title,
        fileIndex: index,
        url: this.torrServer.getStreamUrl(hash, index, filename),
      };
    } catch {
      return null;
    }
  }
}

/** btih-хеш из магнит-ссылки (hex-40 или base32-32). null — хеша нет. */
export function btihOf(magnet: string): string | null {
  const m = /[?&]xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/.exec(magnet);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Ждёт промис не дольше `ms`: по таймауту отдаёт null, а сам промис
 * продолжает работать в фоне (его результат заберут warmFor/saveSource).
 */
async function budget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
