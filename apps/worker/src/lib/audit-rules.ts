/**
 * Правила quality-audit — чистые функции над выборками БД.
 */

/** Порог «длинного сезона»: больше — листать невозможно, нужна раскладка. */
export const LONG_SEASON_AUDIT = 60;

/** Пропущенные номера в отсортированном списке серий (с 1 до максимума). */
export function missingNumbers(numbers: number[], cap = 50): number[] {
  const have = new Set(numbers);
  const max = Math.max(0, ...numbers);
  const out: number[] = [];
  for (let n = 1; n <= max && out.length < cap; n++) if (!have.has(n)) out.push(n);
  return out;
}

/**
 * Сводка дыр нумерации одного тайтла по сезонам. Нумерация «не с 1» без
 * дыр внутри — норма для сезонов-продолжений (26–50) у части источников:
 * это не дыра, а отдельный признак `offset`.
 */
export function summarizeGaps(rows: Array<{ season: number; numbers: number[] }>) {
  const seasons: Array<{ season: number; missing: number[]; offset?: number }> = [];
  for (const r of rows) {
    const nums = r.numbers.map(Number).sort((a, b) => a - b);
    const min = nums[0] ?? 1;
    const internal = missingNumbers(nums).filter((n) => n > min);
    if (internal.length > 0) seasons.push({ season: Number(r.season), missing: internal });
    else if (min > 1) seasons.push({ season: Number(r.season), missing: [], offset: min });
  }
  return seasons;
}

export function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}
