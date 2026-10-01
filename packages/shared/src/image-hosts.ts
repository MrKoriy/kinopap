/**
 * Единый список хостов для poster-image и next.config — раньше парсили
 * NEXT_PUBLIC_EXTRA_IMAGE_HOSTS в двух местах независимо (дрифт).
 */
export function parseExtraImageHosts(raw: string = process.env.NEXT_PUBLIC_EXTRA_IMAGE_HOSTS ?? ""): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const DEFAULT_IMAGE_HOSTS = [
  "image.tmdb.org",
  "localhost:3001",
  "127.0.0.1:3001",
  "localhost:9000",
] as const;

export function allowedImageHosts(extra: string[] = parseExtraImageHosts()): Set<string> {
  return new Set([...DEFAULT_IMAGE_HOSTS, ...extra]);
}
