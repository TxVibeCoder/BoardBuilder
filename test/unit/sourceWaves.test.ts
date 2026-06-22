import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import type { ComponentSpec, Netlist } from '../../src/engine/dsp/netlist';

const FS = 48000;

function net(components: ComponentSpec[], extra: Partial<Netlist> = {}): Netlist {
  return { components, sampleRate: FS, groundEyelet: 'gnd', ...extra };
}
const R = (id: string, a: string, b: string, ohms: number): ComponentSpec => ({ id, kind: 'resistor', pins: [a, b], params: { R: ohms } });
const probe = (n: string): ComponentSpec => ({ id: 'PROBE', kind: 'probe', pins: [n], params: {} });

// A trivial load: source → small Rsrc sets the hot node to ≈Vs, R to ground completes the divider so
// the probe reads the source waveform almost exactly (Rsrc≪R ⇒ split ≈ 1).
const loadNet = (wave: 'pulse' | 'noise', freq: number, amp: number): Netlist =>
  net([
    { id: 'S', kind: 'source', pins: ['hot', 'gnd'], params: { wave, freq, amp, rsrc: 1e-6 } },
    R('R', 'hot', 'gnd', 1000),
    probe('hot'),
  ]);

function run(nl: Netlist, n: number): Float64Array {
  const core = new CircuitCore(nl, FS, { oversample: 1 });
  core.reset();
  const out = new Float64Array(n);
  core.processBlock(new Float64Array(n), out, n);
  return out;
}

describe('source waveforms — pulse + noise', () => {
  it("'pulse' is periodic at its freq and takes both signs", () => {
    const freq = 1000;
    const amp = 2;
    const period = FS / freq; // 48 samples
    const N = 4800; // 100 periods
    const out = run(loadNet('pulse', freq, amp), N);

    // takes both signs, bounded near ±amp (the divider passes ≈ the full source level)
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 200; i < N; i++) {
      if (out[i]! < mn) mn = out[i]!;
      if (out[i]! > mx) mx = out[i]!;
    }
    expect(mx).toBeGreaterThan(0.5 * amp); // positive half present
    expect(mn).toBeLessThan(-0.5 * amp); // negative half present
    expect(mx).toBeLessThanOrEqual(amp * 1.01);
    expect(mn).toBeGreaterThanOrEqual(-amp * 1.01);

    // periodic at freq: the sample one period later matches (square is constant within each half)
    const tol = 1e-6;
    let matches = 0;
    let checks = 0;
    for (let i = 200; i + Math.round(period) < N; i += 5) {
      checks++;
      if (Math.abs(out[i]! - out[i + Math.round(period)]!) < tol) matches++;
    }
    // period is an exact integer (48) so every one-period-apart pair must match
    expect(matches).toBe(checks);

    // and it actually oscillates: a half-period apart it flips sign over a full cycle's worth of samples
    let flips = 0;
    const half = Math.round(period / 2);
    for (let i = 200; i + half < N; i++) {
      if (out[i]! * out[i + half]! < 0) flips++;
    }
    expect(flips).toBeGreaterThan(0); // not a constant / not DC
  });

  it("'noise' is bounded by amp and not constant", () => {
    const amp = 1.5;
    const N = 4096;
    const out = run(loadNet('noise', 1000, amp), N);

    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 50; i < N; i++) {
      // bounded by amp (the source emits ±amp uniform; the ≈unity divider keeps it within amp)
      expect(Math.abs(out[i]!)).toBeLessThanOrEqual(amp * 1.01);
      if (out[i]! < mn) mn = out[i]!;
      if (out[i]! > mx) mx = out[i]!;
    }
    // not constant: white noise spreads across a wide range and hits both signs
    expect(mx - mn).toBeGreaterThan(amp); // a healthy spread, not a flat line
    expect(mx).toBeGreaterThan(0);
    expect(mn).toBeLessThan(0);

    // distinct values (a constant source would repeat) — sample a handful and confirm variety
    const seen = new Set<number>();
    for (let i = 50; i < 200; i++) seen.add(out[i]!);
    expect(seen.size).toBeGreaterThan(50);
  });
});
