import { describe, expect, it } from 'vitest';
import { DiodeClipperCore, type ClipperConfig } from '../../src/engine/dsp/diodeClipperCore';
import { db, fftMag, magAtHz } from '../helpers/spectral';

const FS = 48000;
const F0 = 1000;

/** Render a sine of amplitude `drive` (V) through the clipper. Memoryless ⇒ no transient. */
function render(seconds: number, drive: number, config: Partial<ClipperConfig>): Float32Array {
  const core = new DiodeClipperCore(config);
  const n = Math.floor(seconds * FS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const vin = drive * Math.sin((2 * Math.PI * F0 * i) / FS);
    out[i] = core.processSample(vin);
  }
  return out;
}

function peakAbs(buf: Float32Array): number {
  let m = 0;
  for (const v of buf) {
    const a = Math.abs(v);
    if (a > m) m = a;
  }
  return m;
}

describe('DiodeClipperCore — Phase 0 viability spike (work order §10)', () => {
  it('caps the output near the silicon diode drop, far below the input swing', () => {
    const drive = 2.0;
    const buf = render(0.5, drive, { diode: 'Si', symmetric: true, seriesR: 4700 });
    const peak = peakAbs(buf);
    // Silicon anti-parallel pair clamps the node to roughly its forward knee (~0.5–0.6 V here).
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.75);
    // …and that is a hard clip: the 2 V input swing is reduced to well under half.
    expect(peak).toBeLessThan(0.4 * drive);
  });

  it('symmetric clipper produces odd harmonics and suppresses even ones', () => {
    const buf = render(0.5, 2.0, { diode: 'Si', symmetric: true, seriesR: 4700 });
    const spec = fftMag(buf, FS, 16384, 4096);
    const h1 = magAtHz(spec, F0);
    const h2 = magAtHz(spec, 2 * F0);
    const h3 = magAtHz(spec, 3 * F0);
    const h5 = magAtHz(spec, 5 * F0);

    // odd harmonics clearly present (distortion is happening)
    expect(db(h3 / h1)).toBeGreaterThan(-30);
    expect(db(h5 / h1)).toBeGreaterThan(-45);
    // symmetric ⇒ even harmonics far below the odd ones
    expect(db(h2 / h3)).toBeLessThan(-20);
    expect(db(h2 / h1)).toBeLessThan(-35);
  });

  it('asymmetric (single diode) reintroduces strong even harmonics', () => {
    const sym = fftMag(render(0.5, 2.0, { diode: 'Si', symmetric: true, seriesR: 4700 }), FS, 16384, 4096);
    const asym = fftMag(render(0.5, 2.0, { diode: 'Si', symmetric: false, seriesR: 4700 }), FS, 16384, 4096);
    const h2sym = magAtHz(sym, 2 * F0);
    const h2asym = magAtHz(asym, 2 * F0);
    const h1asym = magAtHz(asym, F0);

    // even harmonics are now a real part of the spectrum…
    expect(db(h2asym / h1asym)).toBeGreaterThan(-25);
    // …and dramatically stronger than the symmetric case (the audible Si→asymmetric lesson).
    expect(h2asym).toBeGreaterThan(h2sym * 10);
  });

  it('higher-drop diodes give more headroom (Si → LED clips less at the same drive)', () => {
    const drive = 2.0;
    const peakSi = peakAbs(render(0.3, drive, { diode: 'Si', symmetric: true, seriesR: 4700 }));
    const peakLed = peakAbs(render(0.3, drive, { diode: 'LED', symmetric: true, seriesR: 4700 }));
    const peakGe = peakAbs(render(0.3, drive, { diode: 'Ge', symmetric: true, seriesR: 4700 }));
    // Ge (lowest drop) clips hardest, LED (highest) clips softest: Ge < Si < LED in surviving swing.
    expect(peakGe).toBeLessThan(peakSi);
    expect(peakLed).toBeGreaterThan(peakSi + 0.4);
  });

  it('the Newton solve converges every sample (cheap, bounded iteration count)', () => {
    const core = new DiodeClipperCore({ diode: 'Si', symmetric: true, seriesR: 4700 });
    let worst = 0;
    for (let i = 0; i < FS; i++) {
      const vin = 2.0 * Math.sin((2 * Math.PI * F0 * i) / FS);
      core.processSample(vin);
      if (core.lastIterations > worst) worst = core.lastIterations;
    }
    // warm-started continuation keeps this small; a blow-up (no convergence) would hit MAX_ITER=100.
    expect(worst).toBeLessThan(40);
  });
});
