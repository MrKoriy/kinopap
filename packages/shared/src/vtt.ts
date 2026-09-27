/**
 * WebVTT: парсер и математика активных реплик.
 * Один код для веба (hls.js-плеер) и мобилы (нативный HLS внешние дорожки
 * не принимает — рисуем реплику оверлеем сами).
 */

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** "00:01:02.500" | "01:02,5" | "1:02:03.250" → секунды. */
function parseTimestamp(raw: string): number | null {
  const m = raw
    .trim()
    .match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

/** Теги и HTML-сущности из реплики: плеер рисует чистый текст. */
function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function parseVtt(raw: string): SubtitleCue[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: SubtitleCue[] = [];

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (!lines.length) continue;
    // NOTE/STYLE/REGION и заголовок WEBVTT без таймкода пропускаем.
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;

    const [fromRaw, toRaw] = lines[timeIdx]!.split("-->");
    const start = parseTimestamp(fromRaw ?? "");
    // Справа может быть хвост настроек ("00:00:04.000 line:90%") — берём первый токен.
    const end = parseTimestamp((toRaw ?? "").trim().split(/\s+/)[0] ?? "");
    if (start == null || end == null) continue;

    const body = cleanText(lines.slice(timeIdx + 1).join("\n"));
    if (body) cues.push({ start, end, text: body });
  }

  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Реплики, активные на момент timeSeconds (секунды), с учётом сдвига.
 * Семантика сдвига едина для всех клиентов: положительный shiftMs
 * показывает реплики из будущего — субтитры появляются РАНЬШЕ
 * (лечит запаздывающие дорожки). Раньше мобильная и веб-версии
 * расходились знаком — одна и та же кнопка работала наоборот.
 */
export function activeCues(
  cues: readonly SubtitleCue[],
  timeSeconds: number,
  shiftMs = 0,
): SubtitleCue[] {
  const t = timeSeconds + shiftMs / 1000;
  return cues.filter((c) => t >= c.start && t <= c.end);
}

/** Последняя активная реплика (перекрывающиеся кью — приоритет поздней). */
export function cueAt(
  cues: readonly SubtitleCue[],
  timeSeconds: number,
  shiftMs = 0,
): SubtitleCue | null {
  const t = timeSeconds + shiftMs / 1000;
  let found: SubtitleCue | null = null;
  for (const cue of cues) {
    if (cue.start > t) break;
    if (t <= cue.end) found = cue;
  }
  return found;
}
