/**
 * Общий транспорт коннектеров: fetch с таймаутом. Реальный локальный HTTP —
 * таймаут должен честно обрывать зависший ответ, а не ждать его.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchWithTimeout } from "../src";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/slow") {
      // Зависший ответ: таймаут обязан сработать раньше.
      setTimeout(() => {
        res.end("late");
      }, 300);
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchWithTimeout", () => {
  it("обычный ответ проходит", async () => {
    const res = await fetchWithTimeout(`${base}/ok`, 2000);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("ok");
  });

  it("таймаут реально срабатывает раньше зависшего ответа", async () => {
    const startedAt = Date.now();
    await expect(fetchWithTimeout(`${base}/slow`, 100)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(290);
  });

  it("внешний сигнал обрывает запрос (комбинируется с таймаутом)", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const promise = fetchWithTimeout(`${base}/slow`, 5000, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(290);
  });
});
