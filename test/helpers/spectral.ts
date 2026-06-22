/**
 * Shared measurement helpers: rms, fftMag, magAtHz, db, zeroCrossFreq.
 * Pure — usable from Vitest (Node) now and from a browser offline-audio harness later.
 * FFT backed by fft.js (test-only dep). Lifted from SynthStack's proven test harness.
 */

import FFT from 'fft.js';

export function rms(buf: ArrayLike<number>, start = 0, end = buf.length): number {
  let sum = 0;
  const n = end - start;
  for (let i = start; i < end; i++) sum += (buf[i] as number) * (buf[i] as number);
  return Math.sqrt(sum / Math.max(1, n));
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export interface Spectrum {
  mags: Float64Array; // size/2 bins, linear magnitude
  binHz: number;
}

/** Hann-windowed magnitude spectrum of buf[offset .. offset+size). size must be a power of 2. */
export function fftMag(buf: ArrayLike<number>, sampleRate: number, size = 8192, offset = 0): Spectrum {
  const fft = new FFT(size);
  const windowed = new Array<number>(size);
  const w = hann(size);
  for (let i = 0; i < size; i++) windowed[i] = ((buf[offset + i] as number) ?? 0) * w[i]!;
  const out = fft.createComplexArray();
  fft.realTransform(out, windowed);
  const mags = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    const re = out[2 * i]!;
    const im = out[2 * i + 1]!;
    mags[i] = Math.hypot(re, im);
  }
  return { mags, binHz: sampleRate / size };
}

export function magAtHz(spec: Spectrum, hz: number, searchBins = 2): number {
  const center = Math.round(hz / spec.binHz);
  let best = 0;
  for (let i = Math.max(0, center - searchBins); i <= center + searchBins && i < spec.mags.length; i++) {
    if (spec.mags[i]! > best) best = spec.mags[i]!;
  }
  return best;
}

export function db(ratio: number): number {
  return 20 * Math.log10(Math.max(ratio, 1e-12));
}

/** Estimate dominant frequency by zero-crossing count (good for near-sinusoids). */
export function zeroCrossFreq(buf: ArrayLike<number>, sampleRate: number, start = 0, end = buf.length): number {
  let crossings = 0;
  let prev = buf[start] as number;
  for (let i = start + 1; i < end; i++) {
    const cur = buf[i] as number;
    if ((prev <= 0 && cur > 0) || (prev >= 0 && cur < 0)) crossings++;
    prev = cur;
  }
  return (crossings / 2) * (sampleRate / (end - start));
}
