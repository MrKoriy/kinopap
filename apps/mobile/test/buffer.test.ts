import { describe, expect, it } from "vitest";
import { bufferedBand } from "../lib/buffer";

describe("bufferedBand", () => {
  it("обычный случай: отрезок от позиции до докуда дотянулись", () => {
    expect(bufferedBand(30, 90, 300)).toEqual({ start: 0.1, end: 0.3 });
  });

  it("впереди скачан весь остаток — отрезок до конца", () => {
    expect(bufferedBand(30, 300, 300)).toEqual({ start: 0.1, end: 1 });
  });

  it("буфер длиннее фильма — конец обрезан единицей", () => {
    expect(bufferedBand(30, 400, 300)).toEqual({ start: 0.1, end: 1 });
  });

  it("-1 (состояние буфера неизвестно) — полосы нет", () => {
    expect(bufferedBand(30, -1, 300)).toBeNull();
  });

  it("буфер не догнал позицию — полосы нет", () => {
    expect(bufferedBand(30, 20, 300)).toBeNull();
  });

  it("буфер ровно под позицией — нулевой ширины не рисуем", () => {
    expect(bufferedBand(30, 30, 300)).toBeNull();
  });

  it("длительность ноль или NaN — полосы нет", () => {
    expect(bufferedBand(30, 90, 0)).toBeNull();
    expect(bufferedBand(30, 90, Number.NaN)).toBeNull();
    expect(bufferedBand(30, 90, Number.POSITIVE_INFINITY)).toBeNull();
  });

  // Отдельно от предыдущего: при нулевой позиции 0/0 даёт NaN, и проверка
  // «конец не больше начала» его пропускает — `NaN <= NaN` ложно. Без явного
  // запрета нулевой длительности наружу ушёл бы {start: NaN, end: NaN}.
  it("нулевая позиция при нулевой длительности — null, а не NaN", () => {
    expect(bufferedBand(0, 0, 0)).toBeNull();
  });

  it("мусорная позиция — полосы нет, а не NaN в стиле", () => {
    expect(bufferedBand(Number.NaN, 90, 300)).toBeNull();
    expect(bufferedBand(-5, 90, 300)).toBeNull();
  });

  it("мусорный буфер — полосы нет", () => {
    expect(bufferedBand(30, Number.NaN, 300)).toBeNull();
    expect(bufferedBand(30, Number.POSITIVE_INFINITY, 300)).toBeNull();
  });

  it("позиция за концом фильма — полосы нет", () => {
    expect(bufferedBand(400, 400, 300)).toBeNull();
  });
});
