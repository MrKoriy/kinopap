"use client";

/**
 * Авторизация мобильного клиента: сессия в Keychain/Keystore,
 * состояние в контексте — как на вебе, только с асинхронным стартом.
 */
import * as React from "react";
import type { User } from "@zal/api-client";
import { createMobileApi, restoreSession, type MobileApi } from "./api";
import { secureStorage } from "./secure-storage";

interface AuthState {
  user: User | null;
  /** Сессия восстановлена из хранилища (или нет) — можно рендерить. */
  ready: boolean;
  api: MobileApi["api"];
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
  const mobile = React.useMemo(() => createMobileApi(secureStorage), []);
  const [user, setUser] = React.useState<User | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    restoreSession(mobile).then(
      (res) => {
        if (cancelled) return;
        setUser(res?.user ?? null);
        setReady(true);
      },
      () => {
        if (!cancelled) setReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mobile]);

  const applyAuth = React.useCallback(
    async (res: { user: User; tokens: { accessToken: string; refreshToken: string; expiresIn: number } }) => {
      await mobile.session.save(res.tokens);
      mobile.api.setToken(res.tokens.accessToken);
      setUser(res.user);
    },
    [mobile],
  );

  const value = React.useMemo<AuthState>(
    () => ({
      user,
      ready,
      api: mobile.api,
      login: async (email, password) => {
        await applyAuth(await mobile.api.login({ email, password }));
      },
      register: async (input) => {
        await applyAuth(await mobile.api.register(input));
      },
      logout: async () => {
        const tokens = await mobile.session.load();
        if (tokens) {
          await mobile.api
            .logout({ refreshToken: tokens.refreshToken })
            .catch(() => {});
        }
        await mobile.session.save(null);
        mobile.api.setToken(null);
        setUser(null);
      },
    }),
    [user, ready, mobile, applyAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
