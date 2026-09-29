/**
 * Ленивые аудио-дорожки: gst-проба на холодных пирах занимает до 45с,
 * поэтому дорожки опрашиваются фоном, пока видео уже играет.
 *
 * Лестница «первая проба через 4с → 2 ретрая с шагом 8с» копипастилась
 * между веб-плеером и мобильным watch-экраном с риском разъезда
 * таймингов. Одна функция — один ритм на обоих клиентах.
 */

export interface PollMediaTracksOptions {
  /** Задержка первой пробы: gst читает ту же голову файла, что и первый
   * сегмент, и не должна конкурировать с ним. */
  initialDelayMs?: number;
  /** Ретраи: прогрев ещё едет — пробуем ещё пару раз, потом сдаёмся. */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Опрашивает источник до первого непустого списка дорожек или исчерпания
 * ретраев. Ошибки глотаются: фоновая дорожка не должна дёргать уже
 * играющий плеер.
 *
 * Возвращает stop() — вызвать в cleanup эффекта, чтобы отменить таймеры.
 */
export function pollMediaTracks<T>(
  fetchTracks: () => Promise<{ audios: readonly T[] }>,
  onLoaded: (audios: T[]) => void,
  opts: PollMediaTracksOptions = {},
): () => void {
  const { initialDelayMs = 4_000, retries = 2, retryDelayMs = 8_000 } = opts;
  let cancelled = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const load = () => {
    void (async () => {
      try {
        const res = await fetchTracks();
        if (cancelled) return;
        if (res.audios.length > 0) {
          onLoaded([...res.audios]);
          return;
        }
      } catch {
        // Фоновая дорожка: сбой не должен дёргать играющий плеер.
      }
      if (!cancelled && attempt < retries) {
        attempt += 1;
        timer = setTimeout(load, retryDelayMs);
      }
    })();
  };

  timer = setTimeout(load, initialDelayMs);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
