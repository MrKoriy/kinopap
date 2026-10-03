/**
 * Выбор файла серии внутри раздачи-сезона.
 *
 * Раньше файл искался только по «S01E05» в имени. Сезонные паки на русских
 * трекерах часто названы иначе: «05. Название.mkv», «Bleach - 245 [1080p]»,
 * «1x05», «Серия 05». Без совпадения резолвер отказывался от раздачи (и
 * правильно — чужая серия хуже никакой), так что у таких паков не играла
 * ни одна серия. Здесь — те же гарантии (ровно один кандидат), но больше
 * форматов имени.
 */

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|mov|webm)$/i;

export interface FileLike {
  id: number;
  path: string;
  length: number;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Убираем числа, которые не номер серии: разрешение, кодеки, битность, год, CRC. */
function scrub(name: string): string {
  return name
    .replace(VIDEO, "")
    .replace(/\[[0-9a-f]{8}\]/gi, " ")
    .replace(/\b\d{3,4}p\b/gi, " ")
    .replace(/\b[xh]\.?26[45]\b|\bhevc\b|\b10.?bit\b|\b(?:aac|ac3|dts|ddp?)\s?\d(?:\.\d)?\b/gi, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s?(?:gb|mb|fps)\b/gi, " ");
}

const largest = (files: FileLike[]) => files.reduce((a, b) => (b.length > a.length ? b : a));

/**
 * Файл серии или null, если однозначно найти нельзя.
 * `absolute` — сквозной номер (аниме-паки нумеруют серии через все сезоны).
 */
export function pickEpisodeFile(
  files: readonly FileLike[],
  season: number,
  episode: number,
  absolute?: number | null,
): FileLike | null {
  const videos = files.filter((f) => VIDEO.test(f.path));
  if (videos.length === 0) return null;

  // 1) S01E05 / s1e5 / 1x05 — явные координаты.
  const explicit = videos.filter((f) => {
    const name = basename(f.path);
    const m = /s0*(\d{1,2})[ ._-]?e0*(\d{1,4})/i.exec(name) ?? /\b0*(\d{1,2})x0*(\d{1,4})\b/i.exec(name);
    return m != null && Number(m[1]) === season && Number(m[2]) === episode;
  });
  if (explicit.length > 0) return largest(explicit);

  // Явные координаты у других файлов есть, а у нашего нет — пак другого сезона.
  if (videos.some((f) => /s\d{1,2}[ ._-]?e\d{1,4}/i.test(basename(f.path)))) return null;

  // 2) Номер серии отдельным токеном: «05.», «- 245 », «[12]», «E05», «Серия 5».
  const numbers = [episode, ...(absolute && absolute !== episode ? [absolute] : [])];
  for (const n of numbers) {
    const token = new RegExp(
      `(?:^|[\\s._\\-\\[(#]|\\b(?:e|ep|серия|series)\\s?)0*${n}(?=$|[\\s._\\-\\])v])`,
      "i",
    );
    const hits = videos.filter((f) => token.test(scrub(basename(f.path))));
    if (hits.length === 1) return hits[0]!;
  }
  // Один-единственный видеофайл на первую серию — это и есть серия (сингл).
  if (videos.length === 1 && episode === 1) return videos[0]!;
  return null;
}
