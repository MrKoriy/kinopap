import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RutorConnector, type SearchCache } from "../src/connectors/rutor";

const ROW = `<tr class="gai"><td>01 Окт 26</td><td><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x">M</a>
<a href="/torrent/1/film">Фильм (2024) WEB-DL 1080p</a></td><td>4.1 GB</td><td><span class="green">42</span><span class="red">3</span></td></tr>`;

let server: Server;
let base = "";
let hits = 0;
let mode: "ok" | "empty" | "down" = "ok";

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    if (mode === "down") {
      res.statusCode = 503;
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(mode === "ok" ? `<table>${ROW}</table>` : "<table></table>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function memoryCache(): SearchCache & { store: Map<string, { value: string; ttl: number }> } {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    get: async (k) => store.get(k)?.value ?? null,
    set: async (k, value, ttl) => {
      store.set(k, { value, ttl });
    },
  };
}

describe("RutorConnector: внешний кэш выдачи", () => {
  beforeEach(() => {
    hits = 0;
    mode = "ok";
  });

  it("повторный поиск берётся из кэша, трекер не трогается", async () => {
    const rutor = new RutorConnector([base]);
    const cache = memoryCache();
    rutor.setCache(cache);

    const first = await rutor.search("Фильм 2024");
    expect(first.length).toBeGreaterThan(0);
    expect(hits).toBe(1);
    await new Promise((r) => setTimeout(r, 0));

    const second = await rutor.search("фильм 2024");
    expect(second).toEqual(first);
    expect(hits).toBe(1);
    const [entry] = [...cache.store.values()];
    expect(entry?.ttl).toBe(6 * 60 * 60);
  });

  it("пустая выдача кэшируется коротко, сбой зеркал — не кэшируется", async () => {
    const rutor = new RutorConnector([base]);
    const cache = memoryCache();
    rutor.setCache(cache);

    mode = "empty";
    expect(await rutor.search("пусто")).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect([...cache.store.values()][0]?.ttl).toBe(20 * 60);

    mode = "down";
    expect(await rutor.search("лежит")).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.store.size).toBe(1);
  });

  it("сломанный кэш не ломает поиск", async () => {
    const rutor = new RutorConnector([base]);
    rutor.setCache({
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
    });
    expect((await rutor.search("Фильм")).length).toBeGreaterThan(0);
  });
});
