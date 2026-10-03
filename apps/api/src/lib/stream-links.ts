/**
 * Подписанные ссылки на HLS-транскодер TorrServer (/gst/...).
 *
 * Раньше nginx проксировал /gst/ наружу без проверки: любой, кто знает формат,
 * мог заставить сервер скачать произвольный торрент по хешу (TorrServer сам
 * добавляет незнакомый хеш из DHT) и раздавать его через наш канал.
 *
 * Теперь API, выдавая ссылку авторизованному пользователю, вшивает в путь срок
 * жизни и подпись: /gst-s/<expires>/<sig>/<hash>/<rest>. nginx проверяет её
 * модулем secure_link и только тогда проксирует на /gst/<hash>/<rest>.
 * Подпись в ПУТИ, а не в query: плейлисты транскодера ссылаются на сегменты
 * относительно, и префикс с подписью наследуется всеми вложенными запросами.
 *
 * Формат подписи совпадает с nginx:
 *   secure_link_md5 "$gst_exp$gst_hash <secret>";  → md5, base64url без '='.
 */

import { createHash } from "node:crypto";

/** Срок жизни ссылки: хватает на длинный фильм с паузами. */
export const GST_LINK_TTL_SEC = 12 * 60 * 60;
/** Округление expires: одинаковые ссылки в пределах часа (кэш браузера/CDN). */
const BUCKET_SEC = 60 * 60;

const GST_PATH = /^(.*?)\/gst\/([0-9a-fA-F]{40})\/(.*)$/;

export function gstSignature(expires: number, hash: string, secret: string): string {
  return createHash("md5").update(`${expires}${hash} ${secret}`).digest("base64url");
}

/** /gst/<hash>/<rest> → /gst-s/<exp>/<sig>/<hash>/<rest>; прочие URL — как есть. */
export function signGstUrl(
  url: string,
  secret: string | undefined,
  nowMs: number = Date.now(),
): string {
  if (!secret) return url;
  const m = url.match(GST_PATH);
  if (!m) return url;
  const [, prefix, hash, rest] = m as unknown as [string, string, string, string];
  const expires = Math.ceil((Math.floor(nowMs / 1000) + GST_LINK_TTL_SEC) / BUCKET_SEC) * BUCKET_SEC;
  return `${prefix}/gst-s/${expires}/${gstSignature(expires, hash, secret)}/${hash}/${rest}`;
}

interface SignableLinks {
  files: Array<{ urls: { http: string; hls: string | null } }>;
  audios: Array<{ url: string | null; masterUrl: string | null }>;
}

/**
 * Копия ответа с подписанными ссылками. Именно копия: files/audios в ответе
 * делят ссылки с L1-кэшем резолва, и мутация «вшила» бы истекающую подпись
 * в кэш на часы.
 */
export function signStreamLinks<T extends SignableLinks>(links: T, secret: string | undefined): T {
  if (!secret) return links;
  const sign = (u: string | null) => (u == null ? u : signGstUrl(u, secret));
  return {
    ...links,
    files: links.files.map((f) => ({
      ...f,
      urls: { ...f.urls, http: signGstUrl(f.urls.http, secret), hls: sign(f.urls.hls) },
    })),
    audios: links.audios.map((a) => ({ ...a, url: sign(a.url), masterUrl: sign(a.masterUrl) })),
  };
}
