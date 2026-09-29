/**
 * Транспорт клиента: дедлайн запроса, прокидка AbortSignal, один ретрай
 * GET при сетевом сбое. Ответы подменяются инъекцией fetch — до сети тестам
 * дела нет.
 */
import { describe, expect, it } from "vitest";
import {
  ApiError,
  ApiTimeoutError,
  createApiClient,
  DEFAULT_TIMEOUT_MS,
} from "../src/client";

/** AbortError без DOMException: имя важнее класса, его и проверяет клиент. */
function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** fetch, который никогда не отвечает и слушает отмену — как повисший запрос. */
function hangingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetch = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => reject(abortError()));
    });
  return { fetch, calls: () => calls };
}

/** Счётчик вызовов вокруг отвечающего fetch. */
function countingFetch(
  respond: (call: number) => Promise<Response>,
): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetch = (_input: string | URL | Request, _init?: RequestInit) => {
    calls += 1;
    return respond(calls);
  };
  return { fetch, calls: () => calls };
}

describe("таймаут и отмена", () => {
  it("повисший запрос обрывается дедлайном и падает ApiTimeoutError", async () => {
    const impl = hangingFetch();
    const client = createApiClient({
      baseUrl: "http://api.local",
      fetch: impl.fetch,
      timeoutMs: 20,
    });

    await expect(client.health()).rejects.toBeInstanceOf(ApiTimeoutError);
    expect(impl.calls()).toBe(1);
  });

  it("таймаут — это ApiError с кодом timeout", async () => {
    const impl = hangingFetch();
    const client = createApiClient({
      baseUrl: "http://api.local",
      fetch: impl.fetch,
      timeoutMs: 20,
    });

    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body.error.code).toBe("timeout");
  });

  it("таймаут не ретраится: обрыв по дедлайну — не сетевой сбой", async () => {
    const impl = hangingFetch();
    const client = createApiClient({
      baseUrl: "http://api.local",
      fetch: impl.fetch,
      timeoutMs: 20,
    });

    await expect(client.health()).rejects.toBeInstanceOf(ApiTimeoutError);
    expect(impl.calls()).toBe(1);
  });

  it("в fetch уходит AbortSignal с дедлайном", async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      sawSignal = init?.signal ?? undefined;
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    const client = createApiClient({ baseUrl: "http://api.local", fetch: fetchImpl });

    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it("timeoutMs: 0 отключает дедлайн", async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      sawSignal = init?.signal ?? undefined;
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    const client = createApiClient({
      baseUrl: "http://api.local",
      fetch: fetchImpl,
      timeoutMs: 0,
    });

    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(sawSignal).toBeUndefined();
  });

  it("дефолт дедлайна — 30 секунд", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});

describe("ретрай сетевого сбоя", () => {
  it("GET при сбое делает ровно один ретрай", async () => {
    const impl = countingFetch((call) =>
      call === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(jsonResponse({ ok: true })),
    );
    const client = createApiClient({ baseUrl: "http://api.local", fetch: impl.fetch, timeoutMs: 0 });

    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(impl.calls()).toBe(2);
  });

  it("GET падает и после ретрая — ошибка пробрасывается", async () => {
    const impl = countingFetch(() => Promise.reject(new TypeError("fetch failed")));
    const client = createApiClient({ baseUrl: "http://api.local", fetch: impl.fetch, timeoutMs: 0 });

    await expect(client.health()).rejects.toThrow(TypeError);
    expect(impl.calls()).toBe(2);
  });

  it("POST при сбое не ретраится", async () => {
    const impl = countingFetch(() => Promise.reject(new TypeError("fetch failed")));
    const client = createApiClient({ baseUrl: "http://api.local", fetch: impl.fetch, timeoutMs: 0 });

    await expect(client.login({ email: "a@b.co", password: "x" })).rejects.toThrow(TypeError);
    expect(impl.calls()).toBe(1);
  });

  it("HTTP-ошибка не считается сетевым сбоем и не ретраится", async () => {
    const impl = countingFetch(() =>
      Promise.resolve(jsonResponse({ error: { code: "not_found", message: "нет" } }, 404)),
    );
    const client = createApiClient({ baseUrl: "http://api.local", fetch: impl.fetch, timeoutMs: 0 });

    await expect(client.health()).rejects.toBeInstanceOf(ApiError);
    expect(impl.calls()).toBe(1);
  });
});

describe("ответы DELETE и healthz — zod вместо as-кастов", () => {
  it("health разбирает { ok: boolean }", async () => {
    const client = createApiClient({
      baseUrl: "http://api.local",
      fetch: () => Promise.resolve(jsonResponse({ ok: true })),
      timeoutMs: 0,
    });
    await expect(client.health()).resolves.toEqual({ ok: true });
  });

  it("deleteComment требует ok: boolean", async () => {
    const ok = createApiClient({
      baseUrl: "http://api.local",
      fetch: () => Promise.resolve(jsonResponse({ ok: true })),
      timeoutMs: 0,
    });
    await expect(ok.deleteComment(1)).resolves.toEqual({ ok: true });

    const bad = createApiClient({
      baseUrl: "http://api.local",
      fetch: () => Promise.resolve(jsonResponse({ ok: "yes" })),
      timeoutMs: 0,
    });
    await expect(bad.deleteComment(1)).rejects.toThrow();
  });

  it("clearHistory возвращает { ok, removed }", async () => {
    const client = createApiClient({
      baseUrl: "http://api.local",
      fetch: () => Promise.resolve(jsonResponse({ ok: true, removed: 3 })),
      timeoutMs: 0,
    });
    await expect(client.clearHistory()).resolves.toEqual({ ok: true, removed: 3 });
  });

  it("deleteList и deleteHistoryEntry разбираются честно", async () => {
    const client = createApiClient({
      baseUrl: "http://api.local",
      fetch: () => Promise.resolve(jsonResponse({ ok: true })),
      timeoutMs: 0,
    });
    await expect(client.deleteList(1)).resolves.toEqual({ ok: true });
    await expect(client.deleteHistoryEntry(2)).resolves.toEqual({ ok: true });
  });
});
