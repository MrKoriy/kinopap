import { describe, expect, it } from "vitest";
import { createSession, isSessionTokens, type TokenStorage } from "../lib/session";

function fakeStorage(): TokenStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
}

const tokens = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresIn: 900,
};

describe("isSessionTokens", () => {
  it("пропускает валидный объект и отбрасывает мусор", () => {
    expect(isSessionTokens(tokens)).toBe(true);
    expect(isSessionTokens(null)).toBe(false);
    expect(isSessionTokens("строка")).toBe(false);
    expect(isSessionTokens({ ...tokens, accessToken: "" })).toBe(false);
    expect(isSessionTokens({ ...tokens, expiresIn: "900" })).toBe(false);
  });
});

describe("createSession", () => {
  it("сохраняет и восстанавливает токены", async () => {
    const storage = fakeStorage();
    const session = createSession(storage);

    expect(await session.load()).toBeNull();
    await session.save(tokens);
    expect(await session.load()).toEqual(tokens);

    await session.save(null);
    expect(await session.load()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("терпит битый JSON в хранилище", async () => {
    const storage = fakeStorage();
    storage.data.set("zal.tokens", "{не json");
    expect(await createSession(storage).load()).toBeNull();
  });

  it("игнорирует сохранённый мусор", async () => {
    const storage = fakeStorage();
    storage.data.set("zal.tokens", JSON.stringify({ hello: "world" }));
    expect(await createSession(storage).load()).toBeNull();
  });
});
