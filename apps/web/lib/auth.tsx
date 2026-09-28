"use client";

import {
  type ApiClient,
  createApiClient,
  type Tokens,
  type User,
} from "@zal/api-client";
/**
 * Авторизация веб-клиента.
 *
 * Refresh-токен живёт в httpOnly-cookie (доступна только API, XSS её не
 * читает), access — в памяти процесса: перезагрузка страницы восстанавливает
 * сессию через POST /v1/auth/refresh по куке. localStorage больше не хранит
 * ничего критичного. 401 → single-flight refresh → повтор запроса; logout —
 * только если refresh сам не прошёл.
 */
import * as React from "react";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");

interface AuthState {
  user: User | null;
  /** null пока cookie-refresh не попробован; после — юзер или гость. */
  ready: boolean;
  /** Залогинен ли (прогресс/голоса/подписки персональны). */
  isAuthed: boolean;
  api: ApiClient;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    invite: string;
    email: string;
    password: string;
    name: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(null);
  const [ready, setReady] = React.useState(false);

  const api = React.useMemo(() => {
    const clearSession = () => {
      client.setToken(null);
      setUser(null);
    };

    // Single-flight: несколько параллельных 401 дожидаются одного refresh.
    let refreshInFlight: Promise<boolean> | null = null;

    const client = createApiClient({
      baseUrl: API_URL,
      // httpOnly-cookie с refresh-токеном ходит с каждым auth-запросом.
      credentials: "include",
      onUnauthorized: async () => {
        if (!refreshInFlight) {
          refreshInFlight = (async () => {
            try {
              // Пустое тело: токен в куке.
              const res = await client.refresh();
              client.setToken(res.tokens.accessToken);
              return true;
            } catch {
              clearSession();
              return false;
            } finally {
              refreshInFlight = null;
            }
          })();
        }
        await refreshInFlight;
      },
    });
    return client;
  }, []);

  // Восстановление сессии: refresh по httpOnly-cookie → me.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.refresh();
        if (cancelled) return;
        api.setToken(res.tokens.accessToken);
        const me = await api.me().catch(() => null);
        if (!cancelled) setUser(me?.user ?? null);
      } catch {
        // 401 — гость (куки нет/отозвана); сбой сети — тоже гость до
        // следующего логина, повторный refresh безопасен.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const applyAuth = React.useCallback(
    (res: { user: User; tokens: Tokens }) => {
      // Refresh уже в httpOnly-cookie; в памяти только короткоживущий access.
      api.setToken(res.tokens.accessToken);
      setUser(res.user);
    },
    [api],
  );

  const value = React.useMemo<AuthState>(
    () => ({
      user,
      ready,
      isAuthed: user != null,
      api,
      login: async (email, password) => {
        applyAuth(await api.login({ email, password }));
      },
      register: async (input) => {
        applyAuth(await api.register(input));
      },
      logout: async () => {
        // Куку чистит API; тело не нужно.
        await api.logout().catch(() => {});
        api.setToken(null);
        setUser(null);
      },
    }),
    [user, ready, api, applyAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** Мягкий доступ: вне AuthProvider (юнит-тесты) — null, а не исключение. */
export function useOptionalAuth(): AuthState | null {
  return React.useContext(AuthContext);
}

export { API_URL };
