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
      } catch (err) {
        // Fallback to torrent search
      }
    }

    // 2. Search torrent releases on Rutor
    const cleanTitle = query.title.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim();
    const cleanOriginal = query.originalTitle?.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim();

    let searchQuery = cleanTitle;
    if (query.seasonNumber != null && query.episodeNumber != null) {
      const s = String(query.seasonNumber).padStart(2, "0");
      const e = String(query.episodeNumber).padStart(2, "0");
      searchQuery += ` s${s}e${e}`;
    }

    let releases: RutorRelease[] = [];
    try {
      releases = await this.rutor.search(searchQuery);
    } catch {
      releases = [];
    }

    // If no releases found, try searching with originalTitle
    if (releases.length === 0 && cleanOriginal) {
      try {
        releases = await this.rutor.search(cleanOriginal);
      } catch {
        // ignore
      }
    }

    // If still no releases and title has year, try title + year
    if (releases.length === 0 && query.year) {
      try {
        releases = await this.rutor.search(`${cleanTitle} ${query.year}`);
      } catch {
        // ignore
      }
    }

    // Filter releases with seeds and map them into media streams
    let viableReleases = releases.filter((r) => r.seeds > 0 || r.peers > 0).slice(0, 8);
    if (viableReleases.length === 0 && releases.length > 0) {
      viableReleases = releases.slice(0, 5);
    }

    let audioIndex = audios.length + 1;

    for (const rel of viableReleases) {
      // Generate TorrServer stream link for the magnet
      const streamUrl = this.torrServer.getStreamUrlForMagnet(rel.magnet, 1);
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
          hls: null, // TorrServer exposes direct HTTP Range stream
        },
      });

      if (rel.dub) {
        audios.push({
          id: audioIndex++,
          index: audios.length,
          codec: "aac",
          channels: 2,
          lang: "rus",
          type: "dub",
          author: {
            title: `${rel.dub} (${rel.quality})`,
            shortTitle: rel.dub.split(",")[0],
          },
          url: null,
          masterUrl: null,
        });
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
}
