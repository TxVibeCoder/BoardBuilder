import { describe, expect, it } from 'vitest';
import { Oversampler, autoFactor, type OsFactor } from '../../src/engine/dsp/oversampler';
import { db, fftMag, magAtHz } from '../helpers/spectral';

const FS = 48000;

/** Run a base-rate input buffer through an Oversampler with the given per-sub-sample nonlinearity. */
function run(factor: OsFactor, input: Float64Array, solveSub: (s: number) => number): Float64Array {
  const os = new Oversampler(factor);
  const out = new Float64Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = os.process(input[i]!, solveSub);
  return out;
}

describe('Oversampler — anti-aliasing half-band cascade', () => {
  it('factor 1 is an exact passthrough of solveSub', () => {
    const os = new Oversampler(1);
    expect(os.factor).toBe(1);
    expect(os.groupDelaySamples).toBe(0);
    const f = (s: number) => Math.tanh(2 * s) + 0.123; // arbitrary, identity-of-mapping check
    for (const x of [-1, -0.3, 0, 0.5, 0.9, 1.7]) {
      expect(os.process(x, f)).toBeCloseTo(f(x), 12);
    }
  });

  it('DC: a constant input → the same constant out (unity passband)', () => {
    for (const factor of [2, 4, 8] as OsFactor[]) {
      const N = 512;
      const inp = new Float64Array(N).fill(0.37);
      const identity = (s: number) => s;
      const out = run(factor, inp, identity);
      // After the FIR fills, the steady-state output equals the DC input.
      expect(out[N - 1]!).toBeCloseTo(0.37, 4);
    }
  });

  it('a pure in-band sine passes with amplitude ≈ unchanged', () => {
    const N = 1 << 14; // 16384
    const freq = 1000;
    const inp = new Float64Array(N);
    for (let i = 0; i < N; i++) inp[i] = Math.sin((2 * Math.PI * freq * i) / FS);
    const out = run(4, inp, (s) => s); // linear: just the rate-change filters

    const half = N >> 1;
    const specIn = fftMag(inp, FS, half, 0);
    const specOut = fftMag(out, FS, half, half); // settled second half
    const gain = magAtHz(specOut, freq) / magAtHz(specIn, freq);
    expect(gain).toBeGreaterThan(0.98);
    expect(gain).toBeLessThan(1.02);
  });

  it('anti-aliasing: 4× suppresses the inharmonic lines that 1× shows', () => {
    const N = 1 << 14;
    // ~1 kHz, but deliberately NOT a sub-multiple of 48 kHz: with an exact 1000 Hz tone every
    // alias of an odd harmonic folds back ONTO an exact harmonic bin (48000 = 48·1000), hiding the
    // aliasing from a "non-harmonic line" search. 1050 Hz pushes the foldback off the harmonic grid
    // so the inharmonic 1× lines are visible — and the 4× suppression is measurable.
    const freq = 1050;
    const inp = new Float64Array(N);
    for (let i = 0; i < N; i++) inp[i] = Math.sin((2 * Math.PI * freq * i) / FS);
    // Hard clip with gain — a rich odd-harmonic generator.
    const clip = (s: number) => Math.max(-0.6, Math.min(0.6, 3 * s));

    const out1 = run(1, inp, clip);
    const out4 = run(4, inp, clip);

    const size = N >> 1; // 8192-point FFT over the settled second half
    const spec1 = fftMag(out1, FS, size, N - size);
    const spec4 = fftMag(out4, FS, size, N - size);

    const fund1 = magAtHz(spec1, freq);
    const fund4 = magAtHz(spec4, freq);

    // Find the worst NON-harmonic line below 20 kHz, in dBc relative to the fundamental.
    function worstAlias(spec: ReturnType<typeof fftMag>, fund: number): number {
      let worst = -Infinity;
      const maxBin = Math.floor(20000 / spec.binHz);
      for (let bin = 1; bin <= maxBin; bin++) {
        const hz = bin * spec.binHz;
        const nearestHarm = Math.round(hz / freq);
        if (nearestHarm < 1) continue;
        // Skip bins within ±150 Hz of any harmonic of 1 kHz (and its FFT-leakage skirt).
        if (Math.abs(hz - nearestHarm * freq) < 150) continue;
        const dbc = db(spec.mags[bin]! / fund);
        if (dbc > worst) worst = dbc;
      }
      return worst;
    }

    const alias1 = worstAlias(spec1, fund1);
    const alias4 = worstAlias(spec4, fund4);

    // The 1× reference must actually show audible aliasing (sanity: the test has teeth).
    expect(alias1).toBeGreaterThan(-50);
    // 4× must push every inharmonic line below ~−50 dBc.
    expect(alias4).toBeLessThan(-50);
    // And it must be a clear improvement over 1×.
    expect(alias4).toBeLessThan(alias1 - 10);
  });

  it('reset clears state (post-reset output matches a fresh instance)', () => {
    const f = (s: number) => Math.max(-0.6, Math.min(0.6, 3 * s));
    const os = new Oversampler(4);
    // Dirty the delay lines.
    for (let i = 0; i < 100; i++) os.process(Math.sin(i), f);
    os.reset();

    const fresh = new Oversampler(4);
    const a = new Float64Array(64);
    const b = new Float64Array(64);
    for (let i = 0; i < 64; i++) {
      const x = Math.sin((2 * Math.PI * 1000 * i) / FS);
      a[i] = os.process(x, f);
      b[i] = fresh.process(x, f);
    }
    for (let i = 0; i < 64; i++) expect(a[i]!).toBeCloseTo(b[i]!, 12);
  });

  it('groupDelaySamples is a non-negative integer, larger for deeper cascades', () => {
    const g2 = new Oversampler(2).groupDelaySamples;
    const g4 = new Oversampler(4).groupDelaySamples;
    const g8 = new Oversampler(8).groupDelaySamples;
    for (const g of [g2, g4, g8]) {
      expect(Number.isInteger(g)).toBe(true);
      expect(g).toBeGreaterThanOrEqual(0);
    }
    expect(g4).toBeGreaterThanOrEqual(g2);
    expect(g8).toBeGreaterThanOrEqual(g4);
  });

  it('autoFactor returns 1 / 4 / 8 per its rule', () => {
    expect(autoFactor({ hasNonlinear: false, hot: false })).toBe(1);
    expect(autoFactor({ hasNonlinear: false, hot: true })).toBe(1); // linear ⇒ no oversampling
    expect(autoFactor({ hasNonlinear: true, hot: false })).toBe(4);
    expect(autoFactor({ hasNonlinear: true, hot: true })).toBe(8);
  });
});
