import { describe, expect, it } from "vitest";
import { cn } from "../src/cn";
import { cssVariables, tokens } from "../src/tokens";

describe("cn", () => {
  it("joins truthy classes", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
    expect(cn()).toBe("");
  });
});

describe("tokens", () => {
  it("exposes css variables for every core color", () => {
    const vars = cssVariables();
    expect(vars["--zal-bg"]).toBe(tokens.color.bg);
    expect(vars["--zal-accent"]).toBe(tokens.color.accent);
    expect(Object.keys(vars)).toHaveLength(8);
  });

  it("has a dark theme: bg is darker than surface", () => {
    expect(tokens.color.bg < tokens.color.surface).toBe(true);
  });
});
