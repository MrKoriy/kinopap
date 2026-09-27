import { describe, expect, it } from "vitest";
import {
  type CursorPayload,
  decodeCursor,
  encodeCursor,
  makeCursor,
} from "../src/cursor";

describe("cursor codec", () => {
  it("roundtrips a payload", () => {
    const payload: CursorPayload = {
      s: "updated",
      d: "desc",
      v: "2026-09-27T12:00:00.000Z",
      id: 42,
    };
    const encoded = encodeCursor(payload);
    expect(decodeCursor(encoded)).toEqual(payload);
  });

  it("roundtrips cyrillic sort values (btoa latin1 trap)", () => {
    const payload: CursorPayload = {
      s: "title",
      d: "asc",
      v: "Брат 2",
      id: 7,
    };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("roundtrips numeric and null values", () => {
    const withNum: CursorPayload = { s: "rating", d: "desc", v: 7.5, id: 1 };
    const withNull: CursorPayload = { s: "year", d: "asc", v: null, id: 2 };
    expect(decodeCursor(encodeCursor(withNum))).toEqual(withNum);
    expect(decodeCursor(encodeCursor(withNull))).toEqual(withNull);
  });

  it("returns null for garbage input", () => {
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("%%%not-base64%%%")).toBeNull();
  });

  it("returns null for well-formed base64 with invalid payload", () => {
    const evil = btoa(encodeURIComponent(JSON.stringify({ s: "nope", d: "up" })));
    expect(decodeCursor(evil)).toBeNull();
  });

  it("makeCursor matches encodeCursor", () => {
    expect(makeCursor({ field: "views", dir: "desc" }, 100, 5)).toBe(
      encodeCursor({ s: "views", d: "desc", v: 100, id: 5 }),
    );
  });
});
