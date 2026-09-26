/**
 * Хранилище медиа. Файлы лежат под относительными ключами вида
 * `ingest/<ts>-<slug>/...`; адаптеры (local, S3) реализуют доступ.
 */
import path from "node:path";

export interface MediaStorage {
  /** Локальная директория для записи по ключу. */
  resolveDir(key: string): string;
  /** Публичный URL по ключу. */
  url(key: string): string;
}

/** Локальное хранилище (в проде — точка монтирования S3/R2/бакета). */
export class LocalStorage implements MediaStorage {
  constructor(
    private readonly root: string,
    private readonly publicBaseUrl: string,
  ) {}

  resolveDir(key: string): string {
    return path.join(this.root, ...key.split("/").filter(Boolean));
  }

  url(key: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/${key.replace(/^\//, "")}`;
  }
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "untitled"
  );
}
