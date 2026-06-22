/**
 * VCO premade acceptance — the astable multivibrator must SELF-OSCILLATE off its Vcc rail (no input),
 * in the audio band, with a finite/bounded output. We build the board → netlist → CircuitCore, run
 * ~0.3 s with a zero input, skip the settling transient, then count steady mean-crossings to estimate
 * the oscillation frequency. The bar (per the work order): it genuinely oscillates (many crossings),
 * stays finite, and lands roughly in the 100–400 Hz target.
 */

import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import { toNetlist } from '../../src/ui/board/boardModel';
import { vcoBoard } from '../../src/ui/board/synth/vcoBoard';

const FS = 48000;

/** Render `seconds` of the self-oscillating circuit (zero input — it needs none) into one Float64Array. */
function render(core: CircuitCore, seconds: number): Float64Array {
  const total = Math.floor(seconds * FS);
  const out = new Float64Array(total);
  const inBlk = new Float64Array(256); // zeros — the VCO drives itself from Vcc
  const outBlk = new Float64Array(256);
  let done = 0;
  while (done < total) {
    const n = Math.min(256, total - done);
    core.processBlock(inBlk, outBlk, n);
    out.set(outBlk.subarray(0, n), done);
    done += n;
  }
  return out;
}

describe('vcoBoard — astable multivibrator VCO', () => {
  it('builds with a valid ground and grounded probe', () => {
    const core = new CircuitCore(toNetlist(vcoBoard.build()), FS);
    expect(core.groundOk).toBe(true);
    expect(core.probeIndex).toBeGreaterThanOrEqual(0);
  });

  it('self-oscillates in the audio band with a finite output', () => {
    const core = new CircuitCore(toNetlist(vcoBoard.build()), FS);
    const trace = render(core, 0.3);

    // Drop the first 0.1 s of start-up settling; analyse the steady tail.
    const seg = trace.subarray(Math.floor(0.1 * FS));
    expect(seg.length).toBeGreaterThan(0);

    // Output must be finite everywhere (no NaN/Inf escaping the solver) and bounded near the rail.
    let finite = true;
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < seg.length; i++) {
      const x = seg[i]!;
      if (!Number.isFinite(x)) finite = false;
      peak = Math.max(peak, Math.abs(x));
      sum += x;
    }
    const mean = sum / seg.length;
    expect(finite).toBe(true);
    expect(peak).toBeGreaterThan(0.1); // real signal, not a dead/clamped node
    expect(peak).toBeLessThan(20); // bounded — nowhere near runaway

    // Count rising mean-crossings → one per period → frequency.
    let crossings = 0;
    for (let i = 1; i < seg.length; i++) {
      if (seg[i - 1]! - mean < 0 && seg[i]! - mean >= 0) crossings++;
    }
    const freq = crossings / (seg.length / FS);
    // eslint-disable-next-line no-console
    console.log(`VCO measured: freq≈${freq.toFixed(1)} Hz, peak≈${peak.toFixed(2)} V, crossings=${crossings}`);

    // Genuinely oscillating (many cycles over 0.2 s), in the audio band.
    expect(crossings).toBeGreaterThan(10);
    expect(freq).toBeGreaterThan(80);
    expect(freq).toBeLessThan(500);
  });
});
