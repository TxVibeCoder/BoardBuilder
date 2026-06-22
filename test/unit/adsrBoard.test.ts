import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import { FLAG_FLOATING, FLAG_NONFINITE } from '../../src/engine/dsp/mnaSystem';
import { isPlayable, toNetlist } from '../../src/ui/board/boardModel';
import * as adsr from '../../src/ui/board/synth/adsrBoard';

const FS = 48000;

/** Windowed RMS of `out` over [from, to). */
function rms(out: Float64Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += out[i]! * out[i]!;
  return Math.sqrt(s / (to - from));
}

describe('adsrBoard — gated envelope → VCA voice', () => {
  const board = adsr.build();

  it('exports a well-formed premade (id/name/teaches/build)', () => {
    expect(adsr.id).toBe('adsr');
    expect(typeof adsr.name).toBe('string');
    expect(adsr.teaches.length).toBeGreaterThan(20);
    expect(isPlayable(board)).toBe(true);
  });

  it('derives a grounded, finite, fault-free netlist', () => {
    const c = new CircuitCore(toNetlist(board), FS, { oversample: 1 });
    expect(c.groundOk).toBe(true);
    const out = new Float64Array(4096);
    c.processBlock(new Float64Array(4096), out, 4096);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(c.flags & FLAG_FLOATING).toBe(0);
    expect(c.flags & FLAG_NONFINITE).toBe(0);
  });

  it('output amplitude TRACKS the gate: gate-high window is louder than gate-low window', () => {
    // The gate is an internal 2 Hz pulse (period 0.5 s = 24000 samples): high for the first half of each
    // period, low for the second. Run two full gate cycles; the audio is driven internally by the sine
    // source, so the probe output comes from the solver itself (extIn unused here).
    const c = new CircuitCore(toNetlist(board), FS, { oversample: 4 });
    c.reset();
    const n = FS; // 1.0 s = two full 2 Hz gate cycles
    const out = new Float64Array(n);
    c.processBlock(new Float64Array(n), out, n);

    expect(out.every((v) => Number.isFinite(v))).toBe(true);

    // Second gate cycle (let attack/release settle through the first). Period = 24000 samples.
    // High phase ≈ [24000, 36000); low phase ≈ [36000, 48000). Sample the SETTLED part of each window,
    // away from the transition edges (attack ramp / release tail).
    const highHi = rms(out, 30000, 35500); // late in the high phase — cap charged, VCA wide open
    const lowLo = rms(out, 42000, 47500); // late in the low phase — cap drained, VCA cut off

    // The amplitude must clearly rise while the gate is high and fall while it is low.
    expect(highHi).toBeGreaterThan(lowLo * 3);
    // and there must be real audio present in the open window (not just a flat DC offset)
    expect(highHi).toBeGreaterThan(1e-4);
  });

  it('the envelope cap voltage itself rises during the gate-high phase and falls during gate-low', () => {
    // Probe the ENVELOPE node (Cenv.a) directly via nodeVoltage to confirm the generator, independent of
    // the VCA. We read the eyelet by re-deriving it from the netlist: the ENV node is where Renv.b lands.
    const net = toNetlist(board);
    const cenv = net.components.find((cc) => cc.id === 'Cenv')!;
    const envEyelet = cenv.pins[0]!; // Cenv pin 'a' = the envelope node
    const c = new CircuitCore(net, FS, { oversample: 4 });
    c.reset();

    // Step through the second gate cycle one block at a time, sampling the envelope voltage.
    const step = 1000;
    const total = FS;
    const samples: { t: number; v: number }[] = [];
    const inb = new Float64Array(step);
    const outb = new Float64Array(step);
    for (let t = 0; t < total; t += step) {
      c.processBlock(inb, outb, step);
      samples.push({ t, v: c.nodeVoltage(envEyelet) });
    }
    const at = (sampleIdx: number): number => samples.find((s) => s.t >= sampleIdx)!.v;
    const envHigh = at(34000); // late high phase — charged
    const envLow = at(46000); // late low phase — drained
    expect(envHigh).toBeGreaterThan(envLow);
    expect(envHigh).toBeGreaterThan(0.5); // a real, non-trivial envelope swing
  });
});
