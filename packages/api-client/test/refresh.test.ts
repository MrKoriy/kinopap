import { describe, expect, it } from "vitest";
import type { Tokens } from "../src/auth";
import { createTokenRefresher, type RefreshCapableClient } from "../src/refresh";

const FIRST: Tokens = { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 };
const ROTATED: Tokens = { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900 };

/** Уступаем микрозадачам, чтобы ротация осталась «в полёте» для второго вызова. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeClient(impl: () => Promise<{ tokens: Tokens }>) {
  const calls: (undefined | { refreshToken: string })[] = [];
  const setTokens: (string | null)[] = [];
  let token: string | null = null;
  const client: RefreshCapableClient & {
    calls: typeof calls;
    setTokens: typeof setTokens;
    readonly token: string | null;
  } = {
    calls,
    setTokens,
    get token() {
      return token;
    },
    refresh(input?: { refreshToken: string }) {
      calls.push(input);
      return impl();
    },
    setToken(t: string | null) {
      token = t;
      setTokens.push(t);
    },
  };
  return client;
}

describe("createTokenRefresher", () => {
  it("пять параллельных 401 дают одну ротацию", async () => {
    const client = makeClient(async () => {
      await tick();
      return { tokens: ROTATED };
    });
    const refresh = createTokenRefresher(() => client);

    const results = await Promise.all([refresh(), refresh(), refresh(), refresh(), refresh()]);

    expect(client.calls).toHaveLength(1);
    expect(results).toEqual([true, true, true, true, true]);
    expect(client.token).toBe(ROTATED.accessToken);
  });

  it("без загрузчика токена тело пустое — режим httpOnly-cookie", async () => {
    const client = makeClient(async () => ({ tokens: ROTATED }));
    const refresh = createTokenRefresher(() => client);

    expect(await refresh()).toBe(true);
    expect(client.calls).toEqual([undefined]);
  });

  it("с загрузчиком токен уходит в теле, ротированная пара сохраняется", async () => {
    const client = makeClient(async () => ({ tokens: ROTATED }));
    const saved: Tokens[] = [];
    const refresh = createTokenRefresher(() => client, {
      loadRefreshToken: async () => FIRST.refreshToken,
      saveTokens: (tokens) => {
        saved.push(tokens);
      },
    });

    expect(await refresh()).toBe(true);
    expect(client.calls).toEqual([{ refreshToken: "refresh-1" }]);
    expect(saved).toEqual([ROTATED]);
    expect(client.token).toBe(ROTATED.accessToken);
  });

  it("ротация не прошла — сессия объявлена мёртвой, повтор не нужен", async () => {
    const client = makeClient(async () => {
      throw new Error("401");
    });
    let lost = 0;
    const refresh = createTokenRefresher(() => client, {
      onSessionLost: () => {
        lost += 1;
      },
    });

    expect(await refresh()).toBe(false);
    expect(lost).toBe(1);
    // Провал не должен трогать токен: чужую сессию он не подтверждает.
    expect(client.setTokens).toEqual([]);
  });

  it("сессия объявляется мёртвой до возврата", async () => {
    // Порядок здесь не придирка: вызывающий по возврату из обработчика решает,
    // что показать. Если состояние сессии чистится «когда-нибудь потом», UI
    // успевает отрисоваться с живым юзером, которого уже нет.
    const client = makeClient(async () => {
      throw new Error("401");
    });
    const order: string[] = [];
    const refresh = createTokenRefresher(() => client, {
      onSessionLost: async () => {
        await tick();
        order.push("lost");
      },
    });

    await refresh().then(() => order.push("returned"));

    expect(order).toEqual(["lost", "returned"]);
  });

  it("провал не кэшируется: следующий 401 пробует ротацию снова", async () => {
    let attempt = 0;
    const client = makeClient(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("сеть");
      return { tokens: ROTATED };
    });
    const refresh = createTokenRefresher(() => client);

    expect(await refresh()).toBe(false);
    expect(await refresh()).toBe(true);
    expect(client.calls).toHaveLength(2);
  });

  it("после успешной ротации следующий 401 ротирует заново", async () => {
    const client = makeClient(async () => ({ tokens: ROTATED }));
    const refresh = createTokenRefresher(() => client);

    await refresh();
    await refresh();

    expect(client.calls).toHaveLength(2);
  });

  it("загрузчик есть, токена нет — в API не ходим", async () => {
    const client = makeClient(async () => ({ tokens: ROTATED }));
    let lost = 0;
    const refresh = createTokenRefresher(() => client, {
      loadRefreshToken: () => undefined,
      onSessionLost: () => {
        lost += 1;
      },
    });

    expect(await refresh()).toBe(false);
    expect(client.calls).toHaveLength(0);
    expect(lost).toBe(1);
  });

  it("параллельные 401 без токена объявляют сессию мёртвой один раз", async () => {
    const client = makeClient(async () => ({ tokens: ROTATED }));
    let lost = 0;
    const refresh = createTokenRefresher(() => client, {
      loadRefreshToken: async () => {
        await tick();
        return undefined;
      },
      onSessionLost: () => {
        lost += 1;
      },
    });

    expect(await Promise.all([refresh(), refresh(), refresh()])).toEqual([false, false, false]);
    expect(lost).toBe(1);
  });
});
