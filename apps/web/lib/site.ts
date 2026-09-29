// Публичный адрес сайта: metadataBase (OG/канонические URL), карта сайта.
// Спека sitemap и соцсети требуют абсолютные URL, поэтому без env в dev
// подставляем localhost:3000, а не пустую базу.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

/** Абсолютный URL маршрута: new URL(path, base) заодно чинит двойные слэши. */
export function absoluteUrl(path: string, base: string = SITE_URL): string {
  return new URL(path, base).toString();
}
