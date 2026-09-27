/**
 * Чистая логика плеера без DOM: парсер WebVTT и математика спрайтов.
 * Вынесено отдельно, чтобы юнит-тесты не тянули React и hls.js.
 */

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

function parseTimestamp(ts: string): number {
  // "HH:MM:SS.mmm" | "MM:SS.mmm"
  const parts = ts.trim().split(":");
  const secs = Number(parts.pop()?.replace(",", ".") ?? NaN);
  const mins = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  if (!Number.isFinite(secs)) return NaN;
  return hours * 3600 + mins * 60 + secs;
}

/** Разбор WebVTT в таймлайн-кью. Теги вида <b> вырезаются. */
export function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue;

    const [startRaw, endRaw] = lines[timingIdx]!.split("-->");
    const start = parseTimestamp(startRaw ?? "");
    const end = parseTimestamp((endRaw ?? "").trim().split(/\s+/)[0] ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const text = lines
      .slice(timingIdx + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "");
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

/** Кью, активные в момент времени (с учётом сдвига ±мс). */
export function activeCues(cues: VttCue[], timeSeconds: number, shiftMs = 0): VttCue[] {
  const t = timeSeconds + shiftMs / 1000;
  return cues.filter((c) => t >= c.start && t <= c.end);
}

/* ---------- Спрайты скраббинга ---------- */

export interface SpriteTile {
  col: number;
  row: number;
  /** CSS background-position в пикселях (со знаком). */
  backgroundPosition: string;
}

export interface SpriteMetaLike {
  intervalSeconds: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  count: number;
}

/** Тайл спрайта для момента времени. */
export function spriteTileFor(timeSeconds: number, meta: SpriteMetaLike): SpriteTile {
  const idx = Math.max(
    0,
    Math.min(meta.count - 1, Math.floor(timeSeconds / meta.intervalSeconds)),
  );
  const col = idx % meta.columns;
  const row = Math.floor(idx / meta.columns);
  return {
    col,
    row,
    backgroundPosition: `-${col * meta.tileWidth}px -${row * meta.tileHeight}px`,
  };
}

/* ---------- Маркер интро ---------- */

export function isIntroVisible(
  timeSeconds: number,
  intro: { startSeconds: number; endSeconds: number } | null | undefined,
): boolean {
  return !!intro && timeSeconds >= intro.startSeconds && timeSeconds < intro.endSeconds;
}

/** Показывать ли оверлей «следующая серия» (последние 10 секунд). */
export function isNearEnd(timeSeconds: number, duration: number): boolean {
  return duration > 0 && duration - timeSeconds <= 10 && timeSeconds < duration;
}
