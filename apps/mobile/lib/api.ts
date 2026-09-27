/**
 * API-клиент мобильного приложения: общий @zal/api-client,
 * токены живут в асинхронном хранилище, 401 снимает сессию.
 */
import { createApiClient, type ApiClient, type User } from "@zal/api-client";
import { createSession, type Session, type TokenStorage } from "./session";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001";

export interface MobileApi {
  api: ApiClient;
  session: Session;
}

/** Клиент с хранилищем токенов; onUnauthorized выкидывает сессию. */
export function createMobileApi(storage: TokenStorage): MobileApi {
  const session = createSession(storage);
  const api = createApiClient({
    baseUrl: API_URL,
    onUnauthorized: async () => {
      await session.save(null);
      api.setToken(null);
    },
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
  } catch {
    await m.session.save(null);
    m.api.setToken(null);
    return null;
  }
}
