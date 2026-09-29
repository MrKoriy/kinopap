/**
 * API-клиент мобильного приложения: общий @zal/api-client,
 * токены живут в асинхронном хранилище.
 * 401 → single-flight refresh → повтор запроса; logout только если
 * refresh сам не прошёл (раньше истёкший access = молчаливый разлогон
 * каждые 15 минут, а UI продолжал показывать живую сессию).
 */
import {
  type ApiClient,
  ApiError,
  createApiClient,
  createTokenRefresher,
  type User,
} from "@zal/api-client";
import { createSession, type Session, type TokenStorage } from "./session";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001";

export interface MobileApi {
  api: ApiClient;
  session: Session;
}

/** Клиент с хранилищем токенов и refresh-флоу. */
export function createMobileApi(storage: TokenStorage): MobileApi {
  const session = createSession(storage);

  const api = createApiClient({
    baseUrl: API_URL,
    // Политика мобилы: refresh-токен лежит в Keychain, поэтому он идёт в теле
    // запроса, а обновлённая пара сохраняется обратно. Сам single-flight и
    // порядок «ротация → новый access → повтор» — в @zal/api-client, общие с
    // вебом (см. packages/api-client/src/refresh.ts).
    onUnauthorized: createTokenRefresher(() => api, {
      loadRefreshToken: async () => (await session.load())?.refreshToken,
      saveTokens: (tokens) => session.save(tokens),
      onSessionLost: async () => {
        await session.save(null);
        api.setToken(null);
      },
    }),
  });
  return { api, session };
}

/** Восстановление сессии при старте: токен → me; мусор просто сбрасывается. */
export async function restoreSession(
  m: MobileApi,
): Promise<{ user: User } | null> {
  const tokens = await m.session.load();
  if (!tokens) return null;
  m.api.setToken(tokens.accessToken);
  try {
    return await m.api.me();
  } catch (err) {
    // 401 — сессия мертва (refresh уже пробовали). Сбой сети — сохраняем
    // токены: следующий запрос сам сделает refresh.
    if (err instanceof ApiError && err.status === 401) {
      await m.session.save(null);
      m.api.setToken(null);
      return null;
    }
    return null;
  }
}
