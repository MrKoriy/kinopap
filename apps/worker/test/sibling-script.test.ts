import { describe, expect, it } from "vitest";
import { siblingScript } from "../src/lib/sibling-script";

describe("siblingScript", () => {
  it("из исходников запускает соседний .ts тем же загрузчиком", () => {
    const s = siblingScript("file:///app/apps/worker/src/autopilot.ts", "backfill-trailers");
    expect(s.path).toBe("/app/apps/worker/src/backfill-trailers.ts");
    expect(s.args.at(-1)).toBe(s.path);
  });

  it("из бандла запускает соседний dist/*.js", () => {
    const s = siblingScript("file:///app/apps/worker/dist/chunk-ABC.js", "backfill-trailers");
    expect(s.path).toBe("/app/apps/worker/dist/backfill-trailers.js");
  });
});
