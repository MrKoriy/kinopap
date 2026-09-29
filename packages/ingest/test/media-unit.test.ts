/**
 * Юнит-тесты без ffmpeg: формула таймаута encode и потолок тайлов спрайта.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ENCODE_TIMEOUT_MS, MAX_TILES, resolveEncodeTimeoutMs, spriteTileLayout } from "../src";

const HOUR_MS = 60 * 60 * 1000;

describe("resolveEncodeTimeoutMs", () => {
  const FOUR_HOURS = DEFAULT_ENCODE_TIMEOUT_MS;

  it("без опций — базовый потолок 4 часа", () => {
    expect(resolveEncodeTimeoutMs({})).toBe(FOUR_HOURS);
  });

  it("короткий источник: масштаб меньше базового — берём базовый", () => {
    expect(resolveEncodeTimeoutMs({ durationSeconds: 600 })).toBe(FOUR_HOURS);
    expect(resolveEncodeTimeoutMs({ durationSeconds: 0 })).toBe(FOUR_HOURS);
  });

  it("длинный источник: 2× длительности перебивает базовый", () => {
    // 3 часа → 6 часов таймаута.
    expect(resolveEncodeTimeoutMs({ durationSeconds: 3 * 3600 })).toBe(6 * HOUR_MS);
  });

  it("явный encodeTimeoutMs уважается как есть, даже ниже базового", () => {
    expect(resolveEncodeTimeoutMs({ encodeTimeoutMs: 60_000 })).toBe(60_000);
    expect(
      resolveEncodeTimeoutMs({ encodeTimeoutMs: 60_000, durationSeconds: 10 * 3600 }),
    ).toBe(60_000);
  });

  it("двухчасовой фильм: ниже потолка не опускается", () => {
    // 2 часа × 2 = 4 часа = базовый.
    expect(resolveEncodeTimeoutMs({ durationSeconds: 2 * 3600 })).toBe(FOUR_HOURS);
  });
});

describe("spriteTileLayout", () => {
  it("короткий файл: интервал как задан, без пересчёта", () => {
    const layout = spriteTileLayout(120, 5);
    expect(layout).toEqual({ intervalSeconds: 5, count: 24 });
  });

  it("интервал не длиннее длительности файла", () => {
    const layout = spriteTileLayout(2, 5);
    expect(layout).toEqual({ intervalSeconds: 2, count: 1 });
  });

  it("двухчасовой фильм: тайлы зажаты до MAX_TILES", () => {
    // 7200с / 5с = 1440 тайлов → интервал пересчитывается.
    const layout = spriteTileLayout(2 * 3600, 5);
    expect(layout.count).toBeLessThanOrEqual(MAX_TILES);
    expect(layout.count).toBe(MAX_TILES);
    expect(layout.intervalSeconds).toBe(Math.ceil((2 * 3600) / MAX_TILES));
  });

  it("ceil(duration/MAX_TILES) при большом интервале не даёт лишних тайлов", () => {
    // Уже редкий интервал — пересчёт не нужен.
    const layout = spriteTileLayout(2 * 3600, 30);
    expect(layout).toEqual({ intervalSeconds: 30, count: 240 });
  });

  it("нулевой duration — хотя бы один тайл", () => {
    expect(spriteTileLayout(0, 5).count).toBe(1);
  });
});
