/**
 * Трейлеры: одна точка правды про YouTube-ссылки для web и mobile.
 *
 * TMDb отдаёт видео в поле `key` (голый 11-символьный id), но трейлеры
 * попадают в базу и из других мест — старым импортом, руками, будущими
 * провайдерами. Поэтому вход принимаем в любом виде: watch/embed/shorts/
 * youtu.be/голый id, а наружу отдаём каноничные URL.
 */

/** Канонический id ролика; null — если это не видео YouTube. */
export function youtubeVideoId(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // Голый id (так отдаёт TMDb в videos[].key).
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const isYouTube =
    host === "youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be" ||
    host.endsWith(".youtube.com") ||
    host.endsWith(".youtube-nocookie.com");
  if (!isYouTube) return null;

  const candidate =
    host === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") ??
        // /embed/<id>, /shorts/<id>, /v/<id>, /live/<id>
        /^\/(?:embed|shorts|v|live)\/([A-Za-z0-9_-]{11})/.exec(url.pathname)?.[1];

  return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

export interface TrailerRef {
  /** TMDb video key или что угодно, из чего достаётся id. */
  id?: string | null;
  /** Полная ссылка (может быть в любой форме). */
  url?: string | null;
}

/** URL для встраивания (iframe / WebView). null — трейлера нет. */
export function youtubeEmbedUrl(ref: TrailerRef | null | undefined): string | null {
  const id = youtubeVideoId(ref?.id) ?? youtubeVideoId(ref?.url);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

/** URL для внешнего плеера/приложения (mobile: Linking.openURL). */
export function youtubeWatchUrl(ref: TrailerRef | null | undefined): string | null {
  const id = youtubeVideoId(ref?.id) ?? youtubeVideoId(ref?.url);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/**
 * Запасной вариант, когда трейлера нет: поиск по названию.
 * Не выдаём это за трейлер тайтла — UI помечает его как «поиск».
 */
export function youtubeSearchEmbedUrl(title: string, year?: number | null): string {
  const query = year ? `${title} ${year} трейлер` : `${title} трейлер`;
  return `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(query)}`;
}

export interface TrailerSource {
  /** Каноничный embed-URL: реальный трейлер или поиск. */
  embedUrl: string;
  /** "youtube" — нашли ролик TMDb; "search" — фолбэк на поиск. */
  source: "youtube" | "search";
}

/** Итог для плеера-модалки: реальный трейлер, иначе — поиск по названию. */
export function resolveTrailer(
  item: { title: string; year?: number | null; trailer?: TrailerRef | null },
  opts: { allowSearchFallback?: boolean } = {},
): TrailerSource | null {
  const embedUrl = youtubeEmbedUrl(item.trailer);
  if (embedUrl) return { embedUrl, source: "youtube" };
  if (opts.allowSearchFallback === false) return null;
  return {
    embedUrl: youtubeSearchEmbedUrl(item.title, item.year ?? null),
    source: "search",
  };
}
