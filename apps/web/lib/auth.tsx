"use client";

/**
 * Авторизация веб-клиента: токены в localStorage, состояние в контексте.
 * Для закрытого клуба достаточно; httpOnly-куки — задача фазы харденинга.
 */
import * as React from "react";
import {
  createApiClient,
  type ApiClient,
  type Tokens,
  type User,
} from "@zal/api-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const TOKENS_KEY = "zal.tokens";

export function loadTokens(): Tokens | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Tokens | null): void {
  if (typeof window === "undefined") return;
  if (tokens) window.localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  else window.localStorage.removeItem(TOKENS_KEY);
}

interface AuthState {
  user: User | null;
  tokens: Tokens | null;
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
  const [tokens, setTokens] = React.useState<Tokens | null>(null);
  const [user, setUser] = React.useState<User | null>(null);

  const api = React.useMemo(() => {
    const client = createApiClient({
      baseUrl: API_URL,
      onUnauthorized: async () => {
        saveTokens(null);
        setTokens(null);
        setUser(null);
      },
    });
    const saved = loadTokens();
    if (saved) client.setToken(saved.accessToken);
    return client;
  }, []);

  // При монтировании восстанавливаем сессию и тянем профиль.
  React.useEffect(() => {
    const saved = loadTokens();
    if (!saved) return;
    setTokens(saved);
    api.me().then(
      (res) => setUser(res.user),
      () => {
        saveTokens(null);
        setTokens(null);
      },
    );
  }, [api]);

  const applyAuth = React.useCallback(
    (res: { user: User; tokens: Tokens }) => {
      saveTokens(res.tokens);
      api.setToken(res.tokens.accessToken);
      setTokens(res.tokens);
      setUser(res.user);
    },
    [api],
  );

  const value = React.useMemo<AuthState>(
    () => ({
      user,
      tokens,
      api,
      login: async (email, password) => {
        applyAuth(await api.login({ email, password }));
      },
      register: async (input) => {
        applyAuth(await api.register(input));
      },
      logout: async () => {
        const refresh = loadTokens()?.refreshToken;
        if (refresh) await api.logout({ refreshToken: refresh }).catch(() => {});
        saveTokens(null);
        api.setToken(null);
        setTokens(null);
        setUser(null);
      },
    }),
    [user, tokens, api, applyAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { API_URL };
