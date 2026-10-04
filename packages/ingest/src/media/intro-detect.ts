/**
 * Детектор заставок по звуку (MVP, без нативных зависимостей).
 *
 * Идея как у Jellyfin intro-skipper: у соседних серий одного сезона
 * заставка звучит одинаково. Берём первые ~6 минут звука каждой серии
 * (ffmpeg → PCM s16le 8 кГц моно), считаем акустический отпечаток
 * Haitsma–Kalker (32 бита на кадр ~0.1 с) и ищем самый длинный общий
 * отрезок при любом взаимном сдвиге серий. Отрезок 15–150 с — заставка.
 *
 * Ограничения: заставка должна совпадать по звуку минимум у двух серий
 * подряд (разные опенинги/холодный старт без музыки не найдутся); тихие
 * кадры не участвуют в сравнении; титры в конце серии не ищем.
 */

import { spawn } from "node:child_process";

export const SAMPLE_RATE = 8000;
/** Окно FFT: 1024 отсчёта = 128 мс. */
const FRAME = 1024;
/** Шаг между кадрами отпечатка: 800 отсчётов = 0.1 с. */
const HOP = 800;
export const FRAME_SECONDS = HOP / SAMPLE_RATE;
/** 33 полосы → 32 бита разностей. */
const BANDS = 33;
const MIN_HZ = 300;
const MAX_HZ = 2000;
/** Полуокно (кадров) для оценки плотности совпадений. */
const DENSITY_HALF = 5;

export interface IntroDetectOptions {
  /** Максимум различающихся бит из 32, чтобы кадры считались совпавшими. */
  maxHamming?: number;
  /** Допустимая дыра из несовпавших кадров внутри отрезка (сек). */
  maxGapSeconds?: number;
  minIntroSeconds?: number;
  maxIntroSeconds?: number;
}

export interface IntroMatch {
  /** Заставка в первой серии (сек). */
  aStart: number;
  aEnd: number;
  /** Та же заставка во второй серии (сек). */
  bStart: number;
  bEnd: number;
  /** Доля совпавших кадров внутри отрезка (0..1). */
  score: number;
}

/** Отпечаток: 32-битное слово на кадр; `valid[i]=0` — тихий кадр. */
export interface Fingerprint {
  bits: Uint32Array;
  valid: Uint8Array;
}

/* ---------- FFT ---------- */

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Границы полос в бинах FFT: логарифмическая шкала 300–2000 Гц. */
function bandEdges(): number[] {
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) {
    const hz = MIN_HZ * (MAX_HZ / MIN_HZ) ** (b / BANDS);
    edges.push(Math.round((hz * FRAME) / SAMPLE_RATE));
  }
  return edges;
}

/** PCM s16le (Buffer) → Float32 [-1..1]. */
export function pcmToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Отпечаток Haitsma–Kalker: знак разностей энергий полос по частоте и времени. */
export function fingerprint(samples: Float32Array): Fingerprint {
  const frames = samples.length < FRAME ? 0 : Math.floor((samples.length - FRAME) / HOP) + 1;
  const bits = new Uint32Array(frames);
  const valid = new Uint8Array(frames);
  const edges = bandEdges();
  const hann = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(BANDS);
  let cur = new Float64Array(BANDS);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let rms = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[off + i]!;
      rms += s * s;
      re[i] = s * hann[i]!;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = edges[b]!; k < Math.max(edges[b + 1]!, edges[b]! + 1); k++) e += re[k]! * re[k]! + im[k]! * im[k]!;
      cur[b] = e;
    }
    let word = 0;
    for (let b = 0; b < BANDS - 1; b++) {
      const d = cur[b]! - cur[b + 1]! - (prev[b]! - prev[b + 1]!);
      if (d > 0) word |= 1 << b;
    }
    bits[f] = word >>> 0;
    // Тишина (≈ −50 dBFS) даёт шумовые биты — в сравнении не участвует.
    valid[f] = f > 0 && Math.sqrt(rms / FRAME) > 0.003 ? 1 : 0;
    [prev, cur] = [cur, prev];
  }
  return { bits, valid };
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Самый длинный общий отрезок двух отпечатков при любом сдвиге.
 * Для сдвига d сравниваем кадр i первой серии с кадром i−d второй и
 * ищем ран совпадений с дырами не длиннее maxGap кадров.
 */
export function findCommonSegment(a: Fingerprint, b: Fingerprint, opts: IntroDetectOptions = {}): IntroMatch | null {
  const maxHamming = opts.maxHamming ?? 10;
  const maxGap = Math.round((opts.maxGapSeconds ?? 3) / FRAME_SECONDS);
  const minLen = Math.round((opts.minIntroSeconds ?? 15) / FRAME_SECONDS);
  const maxLen = Math.round((opts.maxIntroSeconds ?? 150) / FRAME_SECONDS);
  const na = a.bits.length;
  const nb = b.bits.length;
  let best: { start: number; end: number; d: number; hits: number } | null = null;
  const hit = new Uint8Array(Math.min(na, nb) + 1);
  const prefix = new Int32Array(Math.min(na, nb) + 2);
  for (let d = -(nb - 1); d < na; d++) {
    const i0 = Math.max(0, d);
    const i1 = Math.min(na, nb + d);
    const n = i1 - i0;
    if (n < minLen) continue;
    for (let k = 0; k < n; k++) {
      const i = i0 + k;
      const j = i - d;
      hit[k] = a.valid[i] === 1 && b.valid[j] === 1 && popcount((a.bits[i]! ^ b.bits[j]!) >>> 0) <= maxHamming ? 1 : 0;
      prefix[k + 1] = prefix[k]! + hit[k]!;
    }
    // Одиночные случайные совпадения (~2% у несвязанного звука) не должны
    // растягивать отрезок: кадр «в заставке», только если вокруг него
    // (окно ±DENSITY_HALF) совпало не меньше половины кадров.
    let runStart = -1;
    let lastIn = -1;
    const close = () => {
      if (runStart < 0) return;
      const len = lastIn - runStart + 1;
      const hits = prefix[lastIn + 1]! - prefix[runStart]!;
      if (len >= minLen && len <= maxLen && hits / len >= 0.5 && (!best || len > best.end - best.start)) {
        best = { start: i0 + runStart, end: i0 + lastIn + 1, d, hits };
      }
    };
    for (let k = 0; k < n; k++) {
      const lo = Math.max(0, k - DENSITY_HALF);
      const hi = Math.min(n, k + DENSITY_HALF + 1);
      const dense = hit[k] === 1 && (prefix[hi]! - prefix[lo]!) * 2 >= hi - lo;
      if (!dense) {
        if (runStart >= 0 && k - lastIn > maxGap) {
          close();
          runStart = -1;
        }
        continue;
      }
      if (runStart < 0) runStart = k;
      lastIn = k;
    }
    close();
  }
  if (!best) return null;
  const { start, end, d, hits } = best as { start: number; end: number; d: number; hits: number };
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    aStart: round(start * FRAME_SECONDS),
    aEnd: round(end * FRAME_SECONDS),
    bStart: round((start - d) * FRAME_SECONDS),
    bEnd: round((end - d) * FRAME_SECONDS),
    score: Math.round((hits / (end - start)) * 100) / 100,
  };
}

/**
 * Заставки для серий сезона по порядку: каждую серию сравниваем со
 * следующей (последнюю — с предыдущей). null — общего отрезка нет.
 */
export function detectSeasonIntros(prints: Fingerprint[], opts?: IntroDetectOptions): ({ start: number; end: number } | null)[] {
  const out: ({ start: number; end: number } | null)[] = prints.map(() => null);
  for (let i = 0; i + 1 < prints.length; i++) {
    const m = findCommonSegment(prints[i]!, prints[i + 1]!, opts);
    if (!m) continue;
    if (!out[i]) out[i] = { start: m.aStart, end: m.aEnd };
    // Пара (i, i+1) задаёт интро и следующей серии, но её собственная пара
    // (i+1, i+2) точнее — перезапишет на следующем шаге, если найдётся.
    out[i + 1] = { start: m.bStart, end: m.bEnd };
  }
  return out;
}

/**
 * Первые `seconds` секунд звука файла/URL через ffmpeg: PCM s16le 8 кГц моно.
 * Таймаут убивает ffmpeg (холодный торрент может не отдавать данные).
 */
export function extractPcm(input: string, opts: { seconds?: number; timeoutMs?: number; ffmpegPath?: string } = {}): Promise<Float32Array> {
  const seconds = opts.seconds ?? 360;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const proc = spawn(
      opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
      ["-nostdin", "-hide_banner", "-loglevel", "error", "-t", String(seconds), "-i", input, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => {
      if (err.length < 2000) err += c.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      // Частичный звук (таймаут) тоже годится, если его хватает на поиск.
      if (buf.length >= SAMPLE_RATE * 2 * 60) resolve(pcmToFloat(buf));
      else reject(new Error(`ffmpeg: код ${code}, звука ${(buf.length / SAMPLE_RATE / 2).toFixed(0)}с ${err.trim().slice(0, 300)}`));
    });
  });
}
