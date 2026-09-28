/**
 * Zero-storage Stream Resolver.
 * Resolves media links on the fly from torrents (TorrServer + Rutor) and anime CDNs.
 */
import type { AudioTrack, MediaFile, MediaLinks } from "@zal/api-client";
import { AnilibriaConnector } from "./connectors/anilibria";
import { RutorConnector, type RutorRelease } from "./connectors/rutor";
import { TorrServerConnector } from "./connectors/torrserver";

export interface ResolveQuery {
  itemId: number;
  mediaId: number;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  type?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

export class StreamResolver {
  public readonly rutor: RutorConnector;
  public readonly torrServer: TorrServerConnector;
  public readonly anilibria: AnilibriaConnector;

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
   */
  async resolve(query: ResolveQuery): Promise<MediaLinks> {
    const files: MediaFile[] = [];
    const audios: AudioTrack[] = [];
    let intro: MediaLinks["intro"] = null;

    // 1. If it's anime or contains anime keywords, try AniLibria for instant HLS
    if (query.type === "anime" || /аниме|anime/i.test(query.title)) {
      try {
        const aniReleases = await this.anilibria.search(query.title);
        if (aniReleases.length > 0) {
          const full = await this.anilibria.getRelease(aniReleases[0].id);
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
        }
      } catch {
        // Fallback to torrent search
      }
    }

    // 2. Search torrent releases on Rutor: русский титул И оригинальный
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

    const settled = await Promise.allSettled([...searchQueries].map((q) => this.rutor.search(q)));
    const byHash = new Map<string, RutorRelease>();
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const rel of r.value) {
        const prev = byHash.get(rel.hash);
        if (!prev || rel.seeds > prev.seeds) byHash.set(rel.hash, rel);
      }
    }
    let releases: RutorRelease[] = [...byHash.values()];

    // Если год не помог (релизы без года в названии) — ищем без года.
    if (releases.length === 0 && query.year) {
      const bare = [cleanTitle, cleanOriginal].filter((t): t is string => !!t);
      const bareSettled = await Promise.allSettled(
        [...new Set(bare)].map((q) => this.rutor.search(q)),
      );
      for (const r of bareSettled) {
        if (r.status !== "fulfilled") continue;
        for (const rel of r.value) {
          const prev = byHash.get(rel.hash);
          if (!prev || rel.seeds > prev.seeds) byHash.set(rel.hash, rel);
        }
      }
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

    let audioIndex = audios.length + 1;

    // Warm-up лучшего релиза: добавляем торрент в TorrServer заранее и
    // выбираем крупнейший видеофайл. Прогрев стартует с открытием
    // watch-страницы — к нажатию «play» пиры уже подключены, а index
    // указывает на фильм, а не на sample/jacket в multi-file релизах.
    const warmed = await this.warmBestRelease(viableReleases[0] ?? null);

    for (const rel of viableReleases) {
      // Generate TorrServer stream link for the magnet
      const isWarmed = warmed && warmed.magnet === rel.magnet;
      const streamUrl = isWarmed
        ? warmed.url
        : this.torrServer.getStreamUrlForMagnet(rel.magnet, 1);
      // HLS через gst-транскодер: звук AAC (Chrome играет), HEVC→H.264.
      // Незнакомый хеш TorrServer подтянет сам — достаточно btih из магнита.
      const hash = isWarmed ? warmed.hash : btihOf(rel.magnet);
      const fileIndex = isWarmed ? warmed.fileIndex : 1;
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

    // Реальные дорожки прогретого релиза из gst-пробы: точные аудио-треки
    // файла (дубляж/оригинал) с персональными HLS-мастерами. Проба не
    // удалась — дорожки не заявляем: дефолтная дорожка в HLS со звуком,
    // а переключать нечего.
    if (warmed) {
      let probe = await this.torrServer.probeGst(warmed.hash, warmed.fileIndex);
      if (!probe) {
        // Торренты из БД после рестарта TorrServer иногда висят без данных
        // («пиры есть, куски не идут») — дропаем и пере-добавляем.
        await this.torrServer.dropTorrent(warmed.hash);
        await this.torrServer.addTorrent(warmed.magnet, warmed.title);
        await new Promise((r) => setTimeout(r, 5000));
        probe = await this.torrServer.probeGst(warmed.hash, warmed.fileIndex);
      }
      if (probe) {
        for (const pad of probe.tracks.filter((t) => t.Type === "audio")) {
          const lang = (pad.Language || "ru").slice(0, 12);
          const isOriginal = lang.startsWith("en");
          const title = pad.Title?.trim()
            ? pad.Title.slice(0, 120)
            : isOriginal
              ? "Оригинал"
              : "Дубляж";
          audios.push({
            id: audioIndex++,
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
            masterUrl: this.torrServer.getGstHlsUrl(warmed.hash, warmed.fileIndex, pad.Index),
          });
        }
      }
    }

    // Default fallback file if no releases matched
    if (files.length === 0) {
      files.push({
        quality: "720p",
        qualityId: 720,
        width: 1280,
        height: 720,
        codec: "h264",
        bitrate: null,
        sizeBytes: null,
        urls: {
          http: `${this.torrServer.baseUrl}/stream?link=none`,
          hls: null,
        },
      });
    }

    return {
      mediaId: query.mediaId,
      itemId: query.itemId,
      files,
      audios,
      subtitles: [],
      posterUrl: null,
      sprites: null,
      intro,
    };
  }

  /**
   * Добавляет релиз в TorrServer (idempotent) и возвращает прямую ссылку
   * на крупнейший видеофайл торрента. null — TorrServer недоступен или
   * метаданные не подтянулись: вызывающий код откатывается на magnet-URL.
   */
  private async warmBestRelease(
    rel: RutorRelease | null,
  ): Promise<{
    magnet: string;
    hash: string;
    title: string;
    fileIndex: number;
    url: string;
  } | null> {
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
