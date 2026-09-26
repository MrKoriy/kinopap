/**
 * Контракты ingest. Источники — source-agnostic: путь или URL,
 * никакой семантики чужих пираток. Свои источники — плагины поверх
 * SourceConnector (search / probe / pull).
 */
import type { ItemType } from "@zal/api-client";
import type { Enrichment } from "@zal/db";

export interface SourceQuery {
  title?: string;
  year?: number;
  limit?: number;
}

export interface SourceEntry {
  /** Идентификатор внутри источника: относительный путь или URL. */
  ref: string;
  title?: string | null;
  year?: number | null;
  /** Внешние субтитры рядом с файлом (.srt/.ass/.vtt). */
  subtitleRefs?: string[];
}

export interface SourceAudioInfo {
  codec: string;
  channels: number;
  lang: string | null;
  title: string | null;
}

export interface SourceVideoInfo {
  codec: string;
  width: number;
  height: number;
  fps: number;
}

export interface SourceSubtitleInfo {
  codec: string;
  lang: string | null;
  title: string | null;
}

export interface SourceInfo {
  ref: string;
  container: string;
  durationSeconds: number;
  video: SourceVideoInfo[];
  audio: SourceAudioInfo[];
  subtitles: SourceSubtitleInfo[];
}

export interface PulledSubtitle {
  path: string;
  lang: string | null;
}

export interface PullOptions {
  workDir: string;
  subtitleRefs?: string[];
}

export interface PulledSource {
  /** Локальный файл, готовый к транскоду. */
  filePath: string;
  subtitlePaths: PulledSubtitle[];
  cleanup: () => Promise<void>;
}

export interface SourceConnector {
  readonly kind: "local" | "url";
  /** Поиск по содержимому источника. */
  search(query: SourceQuery): Promise<SourceEntry[]>;
  /** Метаданные файла/ссылки (ffprobe). */
  probe(ref: string): Promise<SourceInfo>;
  /** Забрать источник в рабочую папку для транскода. */
  pull(ref: string, opts: PullOptions): Promise<PulledSource>;
}

export interface EnrichmentQuery {
  title: string;
  year?: number | null;
  type: ItemType;
}

/** Обогащение метаданными (например TMDb — легальный API). */
export interface MetadataEnricher {
  readonly kind: string;
  find(query: EnrichmentQuery): Promise<Enrichment[]>;
}

export type { Enrichment };
