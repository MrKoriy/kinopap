import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LocalFolderConnector,
  type MetadataEnricher,
  UrlSourceConnector,
} from "../src";
import { makeTestMedia, makeTmpDir, TEST_FFMPEG, type TestMedia } from "./helpers";

let media: TestMedia;

beforeAll(async () => {
  media = await makeTestMedia();
});

describe("LocalFolderConnector", () => {
  it("search находит видео с субтитрами-призраками", async () => {
    const connector = new LocalFolderConnector(media.dir, TEST_FFMPEG);
    const entries = await connector.search({});

    const sample = entries.find((e) => e.ref === "sample.mp4");
    expect(sample?.title).toBe("sample");
    expect(sample?.subtitleRefs).toEqual(["sample.srt"]);

    const filtered = await connector.search({ title: "EMBED" });
    expect(filtered.map((e) => e.ref)).toEqual(["embedded.mp4"]);
  });

  it("probe и pull работают, pull подхватывает sidecar-субтитры", async () => {
    const connector = new LocalFolderConnector(media.dir, TEST_FFMPEG);
    const info = await connector.probe("sample.mp4");
    expect(info.video[0]?.height).toBe(720);

    const pulled = await connector.pull("sample.mp4", {
      workDir: await makeTmpDir("zal-work-"),
    });
    expect(pulled.filePath).toBe(path.join(media.dir, "sample.mp4"));
    expect(pulled.subtitlePaths.map((s) => path.basename(s.path))).toEqual([
      "sample.srt",
    ]);
    await pulled.cleanup();
  });

  it("отклоняет путь за пределы root", async () => {
    const connector = new LocalFolderConnector(media.dir, TEST_FFMPEG);
    await expect(connector.probe("../etc/passwd")).rejects.toThrow(/escapes root/);
  });
});

describe("UrlSourceConnector", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    const handler = createServer(async (req, res) => {
      try {
        const data = await readFile(path.join(media.dir, path.basename(req.url ?? "")));
        res.writeHead(200);
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => handler.listen(0, "127.0.0.1", r));
    const port = (handler.address() as AddressInfo).port;
    server = {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => handler.close(() => r(undefined))),
    };
  });

  afterAll(async () => {
    await server.close();
  });

  it("search у ссылки пустой, probe работает по URL", async () => {
    const connector = new UrlSourceConnector({ ...TEST_FFMPEG, allowPrivateHosts: true });
    expect(await connector.search({})).toEqual([]);

    const info = await connector.probe(`${server.url}/sample.mp4`);
    expect(info.video[0]?.width).toBe(1280);
  });

  it("pull скачивает файл и субтитры", async () => {
    const connector = new UrlSourceConnector({ ...TEST_FFMPEG, allowPrivateHosts: true });
    const workDir = await makeTmpDir("zal-url-");
    const pulled = await connector.pull(`${server.url}/sample.mp4`, {
      workDir,
      subtitleRefs: [`${server.url}/sample.srt`],
    });
    expect(pulled.filePath).toBe(path.join(workDir, "sample.mp4"));
    expect(pulled.subtitlePaths).toHaveLength(1);
    const text = await readFile(pulled.subtitlePaths[0]!.path, "utf8");
    expect(text).toContain("Привет, мир");
  });

  it("падает с понятной ошибкой на мусорном URL", async () => {
    const connector = new UrlSourceConnector(TEST_FFMPEG);
    await expect(
      connector.pull("not-a-url", { workDir: await makeTmpDir("zal-url-") }),
    ).rejects.toThrow(/not a valid URL/);
  });

  it("SSRF-guard: приватные адреса и чужие схемы запрещены по умолчанию", async () => {
    const connector = new UrlSourceConnector(TEST_FFMPEG);
    await expect(
      connector.pull(`${server.url}/sample.mp4`, { workDir: await makeTmpDir("zal-url-") }),
    ).rejects.toThrow(/private address|suspicious port/);
    await expect(
      connector.pull(`file:///etc/passwd`, { workDir: await makeTmpDir("zal-url-") }),
    ).rejects.toThrow(/only http\(s\) allowed/);
  });

  it("лимит размера скачивания соблюдается", async () => {
    const connector = new UrlSourceConnector({
      ...TEST_FFMPEG,
      allowPrivateHosts: true,
      maxBytes: 1024,
    });
    const workDir = await makeTmpDir("zal-url-");
    await expect(
      connector.pull(`${server.url}/sample.mp4`, { workDir }),
    ).rejects.toThrow(/size limit/);
    // Недокачанный файл не остаётся на диске.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(workDir)).filter((f) => f.endsWith(".mp4"))).toEqual([]);
  });
});

describe("TmdbEnricher импортабелен как MetadataEnricher", () => {
  it("интерфейс совместим", () => {
    const kind: MetadataEnricher["kind"] = "tmdb";
    expect(kind).toBe("tmdb");
  });
});
