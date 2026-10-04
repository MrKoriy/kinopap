/**
 * Общая обвязка фоновых скриптов воркера (бэкфиллы, ночные задачи):
 * аргументы CLI, общий ограничитель темпа и пул воркеров над одним курсором.
 */

export function parseArgs(argv: string[] = process.argv.slice(2)) {
  const flag = (name: string) => argv.includes(`--${name}`);
  const num = (name: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    if (!hit) return fallback;
    const n = Number(hit.split("=")[1]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { flag, num };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ограничитель: следующий старт не раньше, чем через paceMs после
 * предыдущего — суммарно по всем воркерам пула.
 */
export function makePacer(paceMs: number): () => Promise<void> {
  let nextStart = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, nextStart);
    nextStart = slot + paceMs;
    if (slot > now) await sleep(slot - now);
  };
}

/** N воркеров над одним асинхронным источником: каждый элемент — ровно одному. */
export async function runPool<T>(
  source: AsyncIterable<T>,
  concurrency: number,
  handle: (row: T) => Promise<void>,
): Promise<void> {
  const it = source[Symbol.asyncIterator]();
  const worker = async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      await handle(next.value);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

/** Курсор по id: страница за страницей, пока не кончится или не упрёмся в limit. */
export async function* pagedById<T extends { id: number }>(
  fetchPage: (afterId: number, limit: number) => Promise<T[]>,
  maxItems: number,
  pageSize = 100,
): AsyncGenerator<T> {
  let afterId = 0;
  let served = 0;
  while (served < maxItems) {
    const batch = await fetchPage(afterId, Math.min(pageSize, maxItems - served));
    if (batch.length === 0) return;
    afterId = batch[batch.length - 1]!.id;
    served += batch.length;
    yield* batch;
  }
}
