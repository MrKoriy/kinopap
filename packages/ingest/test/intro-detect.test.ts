import { describe, expect, it } from "vitest";
import { detectSeasonIntros, findCommonSegment, fingerprint, SAMPLE_RATE } from "../src/media/intro-detect";

/** Детерминированный ГПСЧ (mulberry32), чтобы тест не плавал. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** «Музыка»: смена нот каждые 0.25 с + шум — богатый, неповторяющийся спектр. */
function music(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let f1 = 440;
  let f2 = 660;
  for (let i = 0; i < out.length; i++) {
    if (i % (SAMPLE_RATE / 4) === 0) {
      f1 = 300 + r() * 1600;
      f2 = 300 + r() * 1600;
    }
    const t = i / SAMPLE_RATE;
    out[i] = 0.3 * Math.sin(2 * Math.PI * f1 * t) + 0.2 * Math.sin(2 * Math.PI * f2 * t) + 0.05 * (r() - 0.5);
  }
  return out;
}

/** Серия: уникальный звук, заставка с `at` секунд, снова уникальный. */
function episode(intro: Float32Array, at: number, total: number, seed: number, noise = 0): Float32Array {
  const out = music(total, seed);
  out.set(intro, Math.round(at * SAMPLE_RATE));
  if (noise > 0) {
    const r = rng(seed + 1);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + noise * (r() - 0.5);
  }
  return out;
}

describe("детектор заставок", () => {
  const intro = music(40, 7);

  it("находит общую заставку при разном сдвиге и лёгком шуме", () => {
    const a = fingerprint(episode(intro, 10, 120, 1));
    const b = fingerprint(episode(intro, 25, 120, 2, 0.02));
    const m = findCommonSegment(a, b);
    expect(m).not.toBeNull();
    expect(Math.abs(m!.aStart - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(m!.aEnd - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs(m!.bStart - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(m!.bEnd - 65)).toBeLessThanOrEqual(1);
  });

  it("не находит заставку у разных серий без общего звука", () => {
    const a = fingerprint(music(120, 11));
    const b = fingerprint(music(120, 12));
    expect(findCommonSegment(a, b)).toBeNull();
  });

  it("слишком короткий общий кусок (<15 с) — не заставка", () => {
    const jingle = music(8, 99);
    const a = fingerprint(episode(jingle, 5, 90, 21));
    const b = fingerprint(episode(jingle, 30, 90, 22));
    expect(findCommonSegment(a, b)).toBeNull();
  });

  it("раскладывает заставки по сериям сезона", () => {
    const prints = [0, 30, 60].map((at, k) => fingerprint(episode(intro, at, 120, 31 + k)));
    const res = detectSeasonIntros(prints);
    expect(res.map((r) => (r ? Math.round(r.start) : null))).toEqual([0, 30, 60]);
  });
});
