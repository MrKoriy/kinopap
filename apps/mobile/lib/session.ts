/**
 * Сессия мобильного клиента: токены в асинхронном хранилище
 * (Keychain/Keystore через expo-secure-store в приложении, фейк в тестах).
 * Чистая логика — без привязки к React и Expo.
 */

export interface TokenStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function isSessionTokens(value: unknown): value is SessionTokens {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    v.accessToken.length > 0 &&
    typeof v.refreshToken === "string" &&
    v.refreshToken.length > 0 &&
    typeof v.expiresIn === "number"
  );
}

export interface Session {
  load(): Promise<SessionTokens | null>;
  save(tokens: SessionTokens | null): Promise<void>;
}

const DEFAULT_KEY = "zal.tokens";

/** Сессия поверх любого асинхронного хранилища; мусор в хранилище игнорируется. */
export function createSession(
  storage: TokenStorage,
  key: string = DEFAULT_KEY,
): Session {
  return {
    async load() {
      try {
        const raw = await storage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isSessionTokens(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async save(tokens) {
      if (tokens) await storage.setItem(key, JSON.stringify(tokens));
      else await storage.removeItem(key);
    },
  };
}
