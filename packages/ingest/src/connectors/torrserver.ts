/**
 * TorrServer connector for streaming torrents via memory buffer.
 * Communicates with TorrServer MatriX REST API.
 */

export interface TorrServerFileStat {
  id: number;
  path: string;
  length: number;
}

export interface TorrServerTorrent {
  title: string;
  hash: string;
  name?: string;
  stat?: number;
  stat_string?: string;
  total_peers?: number;
  connected_seeders?: number;
  half_open_peers?: number;
  bytes_read?: number;
  file_stats?: TorrServerFileStat[];
}

export interface TorrServerSettings {
  CacheSize: number;
  ReaderReadAHead: number;
  PreloadCache: number;
  UseDisk: boolean;
  TorrentsSavePath: string;
  ConnectionsLimit: number;
}

/** Один трек из gst-пробы (probe) транскодера TorrServer. */
export interface GstProbeTrack {
  Index: number;
  PadName: string;
  Type: "video" | "audio" | "subtitle";
  Codec?: string;
  Title?: string;
  Language?: string;
  Channels?: number;
}

export interface GstProbe {
  tracks: GstProbeTrack[];
}

const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".webm",
  ".mov",
  ".ts",
]);

export class TorrServerConnector {
  public readonly baseUrl: string;
  public readonly publicBaseUrl: string;

  constructor(
    baseUrl = process.env.TORRSERVER_URL ?? "http://127.0.0.1:8090",
    publicBaseUrl?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.publicBaseUrl = (publicBaseUrl ?? process.env.TORRSERVER_PUBLIC_URL ?? baseUrl).replace(/\/$/, "");
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/echo`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getSettings(): Promise<TorrServerSettings | null> {
    try {
      const res = await fetch(`${this.baseUrl}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      return (await res.json()) as TorrServerSettings;
    } catch {
      return null;
    }
  }

  async configureMemoryBuffer(cacheSizeBytes = 200 * 1024 * 1024): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set",
          sets: {
            CacheSize: cacheSizeBytes,
            UseDisk: false,
            ReaderReadAHead: 95,
            PreloadCache: 10,
            ConnectionsLimit: 250,
          },
        }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Adds torrent to TorrServer without downloading to disk (in-memory buffering).
   */
  async addTorrent(
    magnetOrLink: string,
    title?: string,
  ): Promise<TorrServerTorrent> {
    const res = await fetch(`${this.baseUrl}/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        link: magnetOrLink,
        title: title ?? "",
        save_to_db: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`TorrServer add failed: ${res.statusText}`);
    }

    return (await res.json()) as TorrServerTorrent;
  }

  async getTorrent(hash: string): Promise<TorrServerTorrent | null> {
    try {
      const res = await fetch(`${this.baseUrl}/torrents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", hash }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return (await res.json()) as TorrServerTorrent;
    } catch {
      return null;
    }
  }

  async listTorrents(): Promise<TorrServerTorrent[]> {
    try {
      const res = await fetch(`${this.baseUrl}/torrents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      return (await res.json()) as TorrServerTorrent[];
    } catch {
      return [];
    }
  }

  async removeTorrent(hash: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/torrents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rem", hash }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Drop: сбрасывает соединения и кэш торрента без удаления из базы.
   * Торренты, восстановленные из БД после рестарта сервера, иногда
   * «висят» с подключёнными, но молчащими пирами — drop лечит.
   */
  async dropTorrent(hash: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/torrents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "drop", hash }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Returns playable HTTP stream URL for a file in the torrent.
   * Direct streaming with Range request support (no disk storage).
   */
  getStreamUrl(hash: string, fileIndex = 1, filename?: string): string {
    if (filename) {
      return `${this.publicBaseUrl}/stream/${encodeURIComponent(filename)}?link=${hash}&index=${fileIndex}&play`;
    }
    return `${this.publicBaseUrl}/stream?link=${hash}&index=${fileIndex}&play`;
  }

  getStreamUrlForMagnet(magnet: string, fileIndex = 1): string {
    return `${this.publicBaseUrl}/stream?link=${encodeURIComponent(magnet)}&index=${fileIndex}&play`;
  }

  /**
   * HLS-стрим через gst-транскодер TorrServer: видео remux в fMP4 (HEVC при
   * необходимости перекодируется в H.264), звук — всегда AAC. Единственный
   * формат, который стабильно играет звук в Chrome: роторские релизы почти
   * все с AC3/DTS. Незнакомый хеш TorrServer сам добавляет по DHT.
   * Аудио-дорожка выбирается параметром `audio` (нумерация gst-проба).
   */
  getGstHlsUrl(hash: string, fileIndex = 1, audioIndex = 0): string {
    return `${this.publicBaseUrl}/gst/${hash}/master.m3u8?index=${fileIndex}&audio=${audioIndex}`;
  }

  /** Про-дорожки транскодера: реальные аудио-треки и субтитры файла. */
  async probeGst(
    hash: string,
    fileIndex = 1,
  ): Promise<GstProbe | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/gst/${hash}/probe?index=${fileIndex}`,
        { signal: AbortSignal.timeout(45_000) },
      );
      if (!res.ok) return null;
      const raw = (await res.json()) as { Tracks?: GstProbeTrack[] };
      if (!raw.Tracks) return null;
      return { tracks: raw.Tracks };
    } catch {
      return null;
    }
  }

  /**
   * Предоткрытие потока: читаем голову файла по внутреннему адресу. Размер
   * зависит от режима:
   *  - торренты с редкими сидами (`noName = true`) — 32 МБ, чтобы первые
   *    сегменты gst не ждали пиров по несколько секунд каждый;
   *  - обычные — 10 МБ, достаточно для старта.
   * TorrServer при этом коннектится к пирам и качает первые куски в кэш,
   * а ближайшие запросы (проба/мастер/сегменты) обслуживаются из тёплого
   * кэша. Вызывается fire-and-forget, ошибки игнорируются вызывающим.
   */
  async preopenStream(hash: string, fileIndex: number, noName = false): Promise<void> {
    try {
      const bytes = noName ? 32 * 1024 * 1024 - 1 : 10 * 1024 * 1024 - 1;
      const res = await fetch(
        `${this.baseUrl}/stream?link=${hash}&index=${fileIndex}&play`,
        {
          headers: { Range: `bytes=0-${bytes}` },
          signal: AbortSignal.timeout(noName ? 20_000 : 12_000),
        },
      );
      // Читаем чанк и закрываем — цель: форсировать приоритет головы файла.
      await res.body?.cancel().catch(() => {});
    } catch {
      // Прогрев опционален — поток и без него стартует, просто медленнее.
    }
  }

  /**
   * Finds the best (largest) video file in a torrent.
   */
  findBestVideoFile(
    fileStats: TorrServerFileStat[] | undefined,
  ): TorrServerFileStat | null {
    if (!fileStats || fileStats.length === 0) return null;

    const videoFiles = fileStats.filter((f) => {
      const ext = f.path.substring(f.path.lastIndexOf(".")).toLowerCase();
      return VIDEO_EXTENSIONS.has(ext);
    });

    if (videoFiles.length === 0) return fileStats[0] ?? null;

    // Return the largest video file (main movie file)
    return videoFiles.reduce((best, curr) =>
      curr.length > best.length ? curr : best,
    );
  }
}
