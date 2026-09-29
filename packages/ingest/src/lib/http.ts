/**
 * Общий HTTP-транспорт коннектеров: fetch с таймаутом.
 *
 * До хелпера в пакете жило пять идиом таймаута (controller+setTimeout+finally
 * в rutor/anilibria, inline AbortSignal.timeout в torrserver/tmdb) — теперь
 * одна точка, один тест.
 */

export interface FetchWithTimeoutInit extends RequestInit {
  /** Инжектируемый транспорт (тесты — мок, не сеть). */
  fetchImpl?: typeof fetch;
}

/**
 * fetch, обрывающийся по `timeoutMs`. Внешний `init.signal` (если задан)
 * комбинируется с таймаутом: срабатывает любой из них.
 */
export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  timeoutMs: number,
  init: FetchWithTimeoutInit = {},
): Promise<Response> {
  const { fetchImpl = fetch, ...rest } = init;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, timeoutSignal]) : timeoutSignal;
  return fetchImpl(input, { ...rest, signal });
}
