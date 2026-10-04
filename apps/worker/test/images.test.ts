import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { imageRelDir, processImage, sourceUrl } from "../src/lib/images";

let root: string;

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("image-пайплайн", () => {
  it("постер: AVIF+WebP по ширинам, blurhash, цвет; повтор ничего не пишет", async () => {
    root = await mkdtemp(join(tmpdir(), "kp-img-"));
    const src = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 200, g: 30, b: 40 } } })
      .jpeg()
      .toBuffer();
    const a = await processImage(root, src, "poster");
    expect(a.widths).toEqual([160, 320, 480]);
    expect(a.written).toBe(6);
    expect(a.blurhash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{10,}$/);
    expect(a.color).toMatch(/^#c[0-9a-f]1[0-9a-f]2[0-9a-f]$/);
    const files = (await readdir(join(root, imageRelDir(a.hash)))).sort();
    expect(files).toEqual(["160.avif", "160.webp", "320.avif", "320.webp", "480.avif", "480.webp"]);
    const meta = await sharp(join(root, imageRelDir(a.hash), "320.webp")).metadata();
    expect(meta.width).toBe(320);

    const b = await processImage(root, src, "poster");
    expect(b.hash).toBe(a.hash);
    expect(b.written).toBe(0);
  });

  it("маленький бэкдроп не увеличивается; без blurhash", async () => {
    const src = await sharp({ create: { width: 900, height: 500, channels: 3, background: "#123456" } }).png().toBuffer();
    const r = await processImage(root, src, "backdrop");
    expect(r.widths).toEqual([780]);
    expect(r.blurhash).toBeNull();
  });

  it("исходник TMDb нужного размера", () => {
    expect(sourceUrl("https://image.tmdb.org/t/p/original/a.jpg", "poster")).toBe("https://image.tmdb.org/t/p/w780/a.jpg");
    expect(sourceUrl("https://image.tmdb.org/t/p/w1280/b.jpg", "backdrop")).toBe("https://image.tmdb.org/t/p/w1280/b.jpg");
    expect(sourceUrl("https://cdn.example/x.jpg", "poster")).toBe("https://cdn.example/x.jpg");
  });
});
