/**
 * Прогресс гостя — в localStorage браузера: смотреть можно без входа, и
 * «Продолжить смотреть» / резюме с позиции тоже должны работать без входа.
 * Хранится до 50 последних media; формат совместим с ProgressDto.
 */
import type { ProgressDto } from "@zal/api-client";

const KEY = "kp:guest-progress:v1";
const MAX = 50;

function read(): ProgressDto[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const rows = raw ? (JSON.parse(raw) as ProgressDto[]) : [];
    return Array.isArray(rows) ? rows.filter((r) => typeof r?.mediaId === "number") : [];
  } catch {
    return [];
  }
}

export function listGuestProgress(): ProgressDto[] {
  return read();
}

export function getGuestProgress(mediaId: number): ProgressDto | null {
  return read().find((r) => r.mediaId === mediaId) ?? null;
}

export function saveGuestProgress(itemId: number, mediaId: number, positionSeconds: number, durationSeconds: number): void {
  if (typeof window === "undefined" || !(durationSeconds > 0)) return;
  const ratio = positionSeconds / durationSeconds;
  const row: ProgressDto = {
    itemId,
    mediaId,
    positionSeconds,
    durationSeconds,
    status: ratio >= 0.95 ? "watched" : "in_progress",
    updatedAt: new Date().toISOString(),
  };
  const rows = [row, ...read().filter((r) => r.mediaId !== mediaId)].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    // Переполнен/запрещён localStorage — гостевой прогресс просто не пишется.
  }
}

/** Предпочтение дубляжа на тайтл: «AniDub», «LostFilm»… — между сериями. */
const AUDIO_KEY = "kp:audio-pref:v1";

export function audioLabel(a: { lang: string; author?: { title: string | null } | null }): string {
  return `${a.author?.title ?? ""}|${a.lang}`;
}

export function getAudioPref(itemId: number): string | null {
  if (typeof window === "undefined") return null;
  try {
    const map = JSON.parse(window.localStorage.getItem(AUDIO_KEY) ?? "{}") as Record<string, string>;
    return map[String(itemId)] ?? null;
  } catch {
    return null;
  }
}

export function setAudioPref(itemId: number, label: string): void {
  if (typeof window === "undefined") return;
  try {
    const map = JSON.parse(window.localStorage.getItem(AUDIO_KEY) ?? "{}") as Record<string, string>;
    map[String(itemId)] = label;
    const keys = Object.keys(map);
    if (keys.length > 300) delete map[keys[0]!];
    window.localStorage.setItem(AUDIO_KEY, JSON.stringify(map));
  } catch {
    // нет localStorage — без запоминания
  }
}
