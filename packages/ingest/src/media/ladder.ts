import type { Quality } from "@zal/api-client";

/**
 * Лестница качеств HLS. Апскейла нет: рунг берём не выше исходника,
 * но хотя бы один рунг оставляем всегда.
 */

export interface Rung {
  name: Quality;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  qualityId: number;
}

export const LADDER: Rung[] = [
  { name: "480p", height: 480, videoBitrateKbps: 800, audioBitrateKbps: 96, qualityId: 1 },
  { name: "720p", height: 720, videoBitrateKbps: 1800, audioBitrateKbps: 128, qualityId: 2 },
  { name: "1080p", height: 1080, videoBitrateKbps: 3500, audioBitrateKbps: 192, qualityId: 3 },
  { name: "2160p", height: 2160, videoBitrateKbps: 12000, audioBitrateKbps: 256, qualityId: 4 },
];

/**
 * Выбор рунгов: запрошенные (или все) с высотой не выше исходника.
 * Апскейла нет: если не влезает ни один — берём ближайший снизу, а не
 * первый запрошенный (который может быть 1080p над 480p исходником).
 */
export function selectLadder(
  sourceHeight: number,
  requested?: readonly string[],
): Rung[] {
  const wanted = requested?.length
    ? LADDER.filter((r) => requested.includes(r.name))
    : LADDER;
  const fits = wanted.filter((r) => r.height <= sourceHeight);
  if (fits.length) return fits;
  // Ничего не влезло — берём минимальный рунг из LADDER, но не выше исходника.
  const fallback = LADDER.filter((r) => r.height <= sourceHeight);
  return fallback.length ? [fallback[0]!] : [LADDER[0]!];
}
