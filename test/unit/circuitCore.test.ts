import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import { DiodeClipperCore } from '../../src/engine/dsp/diodeClipperCore';
import { FLAG_FLOATING, FLAG_NO_RETURN_PATH, FLAG_NONFINITE, FLAG_OPAMP_NO_FEEDBACK } from '../../src/engine/dsp/mnaSystem';
import { probeHasNoReturnPath, type ComponentSpec, type Netlist } from '../../src/engine/dsp/netlist';
import { db, fftMag, magAtHz } from '../helpers/spectral';

const FS = 48000;

function net(components: ComponentSpec[], extra: Partial<Netlist> = {}): Netlist {
  return { components, sampleRate: FS, groundEyelet: 'gnd', ...extra };
}
const R = (id: string, a: string, b: string, ohms: number): ComponentSpec => ({ id, kind: 'resistor', pins: [a, b], params: { R: ohms } });
const C = (id: string, a: string, b: string, farads: number): ComponentSpec => ({ id, kind: 'capacitor', pins: [a, b], params: { C: farads } });
const D = (id: string, a: string, k: string, symmetric: boolean): ComponentSpec => ({ id, kind: 'diode', pins: [a, k], params: { diode: 'Si', symmetric } });
const probe = (n: string): ComponentSpec => ({ id: 'PROBE', kind: 'probe', pins: [n], params: {} });
const sineSrc = (id: string, hot: string, gnd: string, freq: number, amp = 1): ComponentSpec => ({ id, kind: 'source', pins: [hot, gnd], params: { wave: 'sine', freq, amp, rsrc: 1e-6 } });
const guitarSrc = (id: string, hot: string, gnd: string, amp = 1): ComponentSpec => ({ id, kind: 'source', pins: [hot, gnd], params: { wave: 'guitar', amp, rsrc: 1e-6 } });

/** Steady-state magnitude response |H(freq)| of a single-source circuit (source amplitude 1). */
function gainAt(core: CircuitCore, srcId: string, freq: number): number {
  core.setValue(srcId, { freq });
  core.reset();
  const period = FS / freq;
  const N = Math.ceil(8 * period + FS * 0.05);
  const inb = new Float64Array(N);
  const out = new Float64Array(N);
  core.processBlock(inb, out, N);
  const M = Math.floor(6 * period);
  let s = 0;
  for (let i = N - M; i < N; i++) s += out[i]! * out[i]!;
  const rms = Math.sqrt(s / M);
  return rms / (1 / Math.SQRT2); // |H| = outRMS / inRMS, inRMS = amp/√2, amp = 1
}

describe('CircuitCore — generalized MNA engine, §9 starter circuits', () => {
  it('§9.1 voltage divider: V_mid = Vin·R2/(R1+R2)', () => {
    const Vin = 9;
    const core = new CircuitCore(net([guitarSrc('S', 'n1', 'gnd'), R('R1', 'n1', 'n2', 1000), R('R2', 'n2', 'gnd', 3000), probe('n2')]));
    const inb = new Float64Array(64).fill(Vin);
    const out = new Float64Array(64);
    core.processBlock(inb, out, 64);
    expect(out[63]!).toBeCloseTo((Vin * 3000) / (1000 + 3000), 4); // 6.75 V
  });

  it('§9.1 high-impedance divider: GMIN_COND does not collapse a 10MΩ/10MΩ divider', () => {
    const core = new CircuitCore(net([guitarSrc('S', 'n1', 'gnd'), R('R1', 'n1', 'n2', 1e7), R('R2', 'n2', 'gnd', 1e7), probe('n2')]));
    const inb = new Float64Array(64).fill(1);
    const out = new Float64Array(64);
    core.processBlock(inb, out, 64);
    expect(out[63]!).toBeCloseTo(0.5, 3); // < 0.1% error proves the split-GMIN choice
  });

  it('§9.2 RC low-pass: −3 dB at f = 1/(2πRC), passband ≈ 1, rolloff above', () => {
    // R = 1591.55 Ω, C = 100 nF ⇒ fc = 1000 Hz
    const core = new CircuitCore(net([sineSrc('S', 'n1', 'gnd', 1000), R('R', 'n1', 'n2', 1591.55), C('C', 'n2', 'gnd', 1e-7), probe('n2')]));
    expect(gainAt(core, 'S', 1000)).toBeCloseTo(0.707, 2);
    expect(gainAt(core, 'S', 100)).toBeGreaterThan(0.95);
    expect(gainAt(core, 'S', 10000)).toBeLessThan(0.15);
  });

  it('§9.3 RC high-pass: −3 dB at fc, blocks lows, passes highs', () => {
    const core = new CircuitCore(net([sineSrc('S', 'n1', 'gnd', 1000), C('C', 'n1', 'n2', 1e-7), R('R', 'n2', 'gnd', 1591.55), probe('n2')]));
    expect(gainAt(core, 'S', 1000)).toBeCloseTo(0.707, 2);
    expect(gainAt(core, 'S', 10000)).toBeGreaterThan(0.9);
    expect(gainAt(core, 'S', 50)).toBeLessThan(0.1);
  });

  it('§9.4 diode clipper SUBSUMES diodeClipperCore numerically (symmetric & asymmetric)', () => {
    for (const symmetric of [true, false]) {
      // force OS=1 so this is an apples-to-apples sample-by-sample comparison with the 1× reference
      const core = new CircuitCore(net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 4700), D('D', 'n2', 'gnd', symmetric), probe('n2')]), 48000, { oversample: 1 });
      const ref = new DiodeClipperCore({ seriesR: 4700, diode: 'Si', symmetric });
      const N = 2400;
      const inb = new Float64Array(N);
      const out = new Float64Array(N);
      for (let i = 0; i < N; i++) inb[i] = 2.0 * Math.sin((2 * Math.PI * 1000 * i) / FS);
      core.processBlock(inb, out, N);
      let maxDiff = 0;
      let maxPos = -Infinity; // the diode (anode at n2) clamps the POSITIVE half in both topologies
      for (let i = 200; i < N; i++) {
        const d = Math.abs(out[i]! - ref.processSample(inb[i]!));
        if (d > maxDiff) maxDiff = d;
        if (out[i]! > maxPos) maxPos = out[i]!;
      }
      expect(maxDiff).toBeLessThan(3e-3); // matches the 1-node reference to sub-mV (the subsumption proof)
      expect(maxPos).toBeLessThan(0.8); // positive swing capped near the Si knee (asym leaves the − half)
    }
  });

  it('§9.4 symmetric clipper shows odd harmonics, asymmetric shows even', () => {
    const run = (symmetric: boolean): Float64Array => {
      const core = new CircuitCore(net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 4700), D('D', 'n2', 'gnd', symmetric), probe('n2')]));
      const N = 1 << 15;
      const inb = new Float64Array(N);
      const out = new Float64Array(N);
      for (let i = 0; i < N; i++) inb[i] = 2.0 * Math.sin((2 * Math.PI * 1000 * i) / FS);
      core.processBlock(inb, out, N);
      return out;
    };
    const symSpec = fftMag(run(true), FS, 16384, 8192);
    const asymSpec = fftMag(run(false), FS, 16384, 8192);
    expect(db(magAtHz(symSpec, 3000) / magAtHz(symSpec, 1000))).toBeGreaterThan(-30);
    expect(db(magAtHz(symSpec, 2000) / magAtHz(symSpec, 1000))).toBeLessThan(-30);
    expect(db(magAtHz(asymSpec, 2000) / magAtHz(asymSpec, 1000))).toBeGreaterThan(-25);
  });

  it('stiff RC does NOT ring (backward-Euler auto-selected): step settles monotonically', () => {
    // 1 nF + 1 kΩ ⇒ τ/dt ≈ 0.05 ⇒ trapezoidal would ring; BE must be chosen.
    const core = new CircuitCore(net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 1000), C('C', 'n2', 'gnd', 1e-9), probe('n2')]));
    const N = 200;
    const inb = new Float64Array(N);
    for (let i = 20; i < N; i++) inb[i] = 1; // step at sample 20
    const out = new Float64Array(N);
    core.processBlock(inb, out, N);
    let reversals = 0;
    for (let i = 22; i < N; i++) {
      const d1 = out[i]! - out[i - 1]!;
      const d0 = out[i - 1]! - out[i - 2]!;
      if (d1 * d0 < -1e-12) reversals++;
    }
    expect(reversals).toBeLessThanOrEqual(1); // no sustained sign-flipping (a ring would give many)
    expect(out[N - 1]!).toBeLessThan(1.01); // no overshoot past the rail value
  });

  it('floating subnet is pinned + flagged, the grounded part still solves (Goal 3)', () => {
    const core = new CircuitCore(
      net([
        guitarSrc('S', 'n1', 'gnd'),
        R('R1', 'n1', 'n2', 1000),
        R('R2', 'n2', 'gnd', 1000),
        probe('n2'),
        R('STRAY', 'x', 'y', 1000), // x,y touch nothing else ⇒ floating
      ]),
    );
    const inb = new Float64Array(64).fill(2);
    const out = new Float64Array(64);
    core.processBlock(inb, out, 64);
    expect(core.flags & FLAG_FLOATING).not.toBe(0);
    expect(Number.isFinite(out[63]!)).toBe(true);
    expect(out[63]!).toBeCloseTo(1.0, 2); // divider unaffected: 2 V × 1k/2k
  });

  it('whole-system-floating (no ground) emits silence, no crash', () => {
    const core = new CircuitCore({ components: [R('R1', 'a', 'b', 1000), R('R2', 'b', 'c', 1000), probe('b')], sampleRate: FS });
    // no source, no ground reference: groundOk picks a net, but with no source it is silent anyway
    const out = new Float64Array(32);
    core.processBlock(new Float64Array(32), out, 32);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it('netlist is the single source of truth: getState/setState JSON round-trip', () => {
    const original = net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 4700), D('D', 'n2', 'gnd', true), probe('n2')]);
    const core = new CircuitCore(original);
    const s1 = core.getState();
    const round = JSON.parse(JSON.stringify(s1)) as Netlist;
    expect(round).toEqual(s1);
    core.setState(round);
    expect(core.getState()).toEqual(s1);
  });
});

const opamp = (id: string, plus: string, minus: string, out: string, vsat = 9): ComponentSpec => ({ id, kind: 'opamp', pins: [plus, minus, out], params: { vsat } });

/** Settle a DC input and return the final probe voltage. */
function dc(core: CircuitCore, vin: number, n = 256): number {
  core.reset();
  const inb = new Float64Array(n).fill(vin);
  const out = new Float64Array(n);
  core.processBlock(inb, out, n);
  return out[n - 1]!;
}

describe('CircuitCore — op-amp circuits (§9.5, §9.6)', () => {
  const gainStage = () => net([guitarSrc('S', 'in', 'gnd'), opamp('U', 'in', 'm', 'out'), R('Rf', 'out', 'm', 100000), R('Rg', 'm', 'gnd', 10000), probe('out')]);

  it('§9.5 non-inverting gain = 1 + Rf/Rg', () => {
    const core = new CircuitCore(gainStage());
    expect(dc(core, 0.1)).toBeCloseTo(1.1, 2); // 0.1·(1+10)
    expect(dc(core, 0.05)).toBeCloseTo(0.55, 2);
  });

  it('§9.5 output saturates at ±Vsat past the rail (no runaway)', () => {
    const core = new CircuitCore(gainStage());
    const hi = dc(core, 1.5); // ideal 16.5 → clamps ≈ +9
    expect(hi).toBeGreaterThan(8.5);
    expect(hi).toBeLessThan(9.05);
    const lo = dc(core, -1.5);
    expect(lo).toBeLessThan(-8.5);
    expect(lo).toBeGreaterThan(-9.05);
  });

  it('§9.5 two cascaded gain stages stay bounded ≤ Vsat (the 121 V regression)', () => {
    const core = new CircuitCore(
      net([
        guitarSrc('S', 'in', 'gnd'),
        opamp('U1', 'in', 'm1', 'o1'), R('Rf1', 'o1', 'm1', 100000), R('Rg1', 'm1', 'gnd', 10000),
        opamp('U2', 'o1', 'm2', 'o2'), R('Rf2', 'o2', 'm2', 100000), R('Rg2', 'm2', 'gnd', 10000),
        probe('o2'),
      ]),
    );
    const o2 = dc(core, 0.1); // 0.1 → 1.1 → 12.1 ideal → clamps ≈ 9, NOT 121
    expect(o2).toBeGreaterThan(8.5);
    expect(o2).toBeLessThan(9.05);
  });

  it('§9.6 op-amp soft-clip: small-signal slope ≈ 1+Rf/Rg, large-signal compresses below the rails', () => {
    const softClip = () => net([guitarSrc('S', 'in', 'gnd'), opamp('U', 'in', 'm', 'out'), R('Rf', 'out', 'm', 100000), R('Rg', 'm', 'gnd', 10000), D('Dclip', 'out', 'm', true), probe('out')]);
    const core = new CircuitCore(softClip());
    expect(dc(core, 0.01) / 0.01).toBeGreaterThan(9.5); // ≈11 before the feedback diodes conduct
    const large = dc(core, 0.6);
    expect(large).toBeLessThan(2.0); // compressed far below 0.6·11 = 6.6
    expect(large).toBeLessThan(8.9); // diodes clip — the rails are NOT what's limiting
    expect(large).toBeGreaterThan(0.6); // still a boost above the input
  });

  it('§9.6 symmetric feedback diodes give odd harmonics', () => {
    const core = new CircuitCore(net([guitarSrc('S', 'in', 'gnd'), opamp('U', 'in', 'm', 'out'), R('Rf', 'out', 'm', 100000), R('Rg', 'm', 'gnd', 10000), D('Dclip', 'out', 'm', true), probe('out')]));
    const N = 1 << 15;
    const inb = new Float64Array(N);
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) inb[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    core.processBlock(inb, out, N);
    const spec = fftMag(out, FS, 16384, 8192);
    expect(db(magAtHz(spec, 3000) / magAtHz(spec, 1000))).toBeGreaterThan(-30);
    expect(db(magAtHz(spec, 2000) / magAtHz(spec, 1000))).toBeLessThan(-25);
  });

  it('pot end-stops (alpha 0 and 1) never NaN (clampPotAlpha)', () => {
    const mk = (alpha: number): CircuitCore =>
      new CircuitCore(net([guitarSrc('S', 'n1', 'gnd'), { id: 'P', kind: 'pot', pins: ['n1', 'w', 'gnd'], params: { alpha, potR: 10000 } }, probe('w')]));
    for (const alpha of [0, 1, 0.5]) {
      expect(Number.isFinite(dc(mk(alpha), 5))).toBe(true);
    }
  });
});

describe('CircuitCore — review-hardening regressions', () => {
  it('ideal:true source degrades to the near-ideal Norton model (drives a divider, no silent fault)', () => {
    const core = new CircuitCore(
      net([
        { id: 'S', kind: 'source', pins: ['n1', 'gnd'], params: { wave: 'guitar', amp: 1, ideal: true } },
        R('R1', 'n1', 'n2', 1000),
        R('R2', 'n2', 'gnd', 1000),
        probe('n2'),
      ]),
    );
    expect(dc(core, 2)).toBeCloseTo(1.0, 2); // 2 V × 1k/2k — the old aux-row bug returned 0
    expect(core.flags & FLAG_OPAMP_NO_FEEDBACK).toBe(0); // and was mislabeled an op-amp fault
  });

  it('two disjoint floating subnets are BOTH pinned; the grounded divider still solves', () => {
    const core = new CircuitCore(
      net([
        guitarSrc('S', 'n1', 'gnd'), R('R1', 'n1', 'n2', 1000), R('R2', 'n2', 'gnd', 1000), probe('n2'),
        R('STRAY1', 'x', 'y', 1000), // two independent floating sub-circuits
        R('STRAY2', 'p', 'q', 2200),
      ]),
    );
    const out = dc(core, 2);
    expect(core.flags & FLAG_FLOATING).not.toBe(0);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeCloseTo(1.0, 2); // single-pin fallback would have zeroed the whole board
  });

  it('series caps (reactive-only middle node) use backward-Euler — no ring on a step', () => {
    const core = new CircuitCore(
      net([
        guitarSrc('S', 'n1', 'gnd'),
        R('R', 'n1', 'n2', 1000),
        C('C1', 'n2', 'n3', 1e-7), // n3 is between two caps: no resistive damping ⇒ must pick BE
        C('C2', 'n3', 'gnd', 1e-7),
        probe('n3'),
      ]),
    );
    const N = 300;
    const inb = new Float64Array(N);
    for (let i = 20; i < N; i++) inb[i] = 1;
    const out = new Float64Array(N);
    core.processBlock(inb, out, N);
    let reversals = 0;
    for (let i = 22; i < N; i++) {
      const d1 = out[i]! - out[i - 1]!;
      const d0 = out[i - 1]! - out[i - 2]!;
      if (d1 * d0 < -1e-12) reversals++;
    }
    expect(reversals).toBeLessThanOrEqual(2); // trapezoidal on this node would ring (dozens of reversals)
    expect(Number.isFinite(out[N - 1]!)).toBe(true);
  });

  it('a frequency knob turn is phase-continuous (no click)', () => {
    const core = new CircuitCore(net([sineSrc('S', 'n1', 'gnd', 500), R('R1', 'n1', 'n2', 1000), R('R2', 'n2', 'gnd', 1000), probe('n2')]));
    const half = 2000;
    const inb = new Float64Array(half);
    const a = new Float64Array(half);
    const b = new Float64Array(half);
    core.processBlock(inb, a, half);
    core.setValue('S', { freq: 700 });
    core.processBlock(inb, b, half);
    // continuous phase ⇒ the straddling step is bounded by the per-sample slope, not a jump to a random phase
    expect(Math.abs(b[0]! - a[half - 1]!)).toBeLessThan(0.1);
  });

  it('NO-RETURN-PATH teaching badge: series part with no path to ground carries no current', () => {
    // The reported bug: source → resistor → probe in a line. The probe draws no current, so the
    // series R drops nothing — output ≈ source and turning R does nothing. Fire the teaching cue.
    const dead = net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 4700), probe('n2')]);
    expect(probeHasNoReturnPath(dead)).toBe(true);
    const core = new CircuitCore(dead);
    expect(core.flags & FLAG_NO_RETURN_PATH).not.toBe(0); // surfaced from topology, before any solve
    expect(dc(core, 1)).toBeCloseTo(1, 3); // and it still plays — the source passes straight through
    expect(core.flags & FLAG_NO_RETURN_PATH).not.toBe(0); // survives the per-sample mna.flags reset

    // two series resistors are just as dead; a series cap (no return path) is too
    expect(probeHasNoReturnPath(net([guitarSrc('S', 'n1', 'gnd'), R('R1', 'n1', 'n2', 1000), R('R2', 'n2', 'n3', 1000), probe('n3')]))).toBe(true);
    expect(probeHasNoReturnPath(net([guitarSrc('S', 'n1', 'gnd'), C('C', 'n1', 'n2', 1e-7), probe('n2')]))).toBe(true);
  });

  it('NO-RETURN-PATH does NOT fire on real working circuits (no false positives)', () => {
    const opamp = (id: string, plus: string, minus: string, out: string): ComponentSpec => ({ id, kind: 'opamp', pins: [plus, minus, out], params: { vsat: 9 } });
    const cases: [string, Netlist][] = [
      ['divider', net([guitarSrc('S', 'n1', 'gnd'), R('R1', 'n1', 'n2', 1000), R('R2', 'n2', 'gnd', 3000), probe('n2')])],
      ['RC low-pass (cap is a path to gnd)', net([sineSrc('S', 'n1', 'gnd', 1000), R('R', 'n1', 'n2', 1591.55), C('C', 'n2', 'gnd', 1e-7), probe('n2')])],
      ['RC high-pass', net([sineSrc('S', 'n1', 'gnd', 1000), C('C', 'n1', 'n2', 1e-7), R('R', 'n2', 'gnd', 1591.55), probe('n2')])],
      ['diode clipper', net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 4700), D('D', 'n2', 'gnd', true), probe('n2')])],
      ['op-amp gain (driven output, out of scope)', net([guitarSrc('S', 'in', 'gnd'), opamp('U', 'in', 'm', 'out'), R('Rf', 'out', 'm', 100000), R('Rg', 'm', 'gnd', 10000), probe('out')])],
      ['shunt R, probe on the source node (not this badge)', net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'gnd', 1000), probe('n1')])],
      ['bare source → probe (nothing in series yet)', net([guitarSrc('S', 'n1', 'gnd'), probe('n1')])],
    ];
    for (const [name, nl] of cases) expect(probeHasNoReturnPath(nl), name).toBe(false);
  });

  it('NO-RETURN-PATH clears when a ground leg turns the series part into a divider', () => {
    const core = new CircuitCore(net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 4700), probe('n2')]));
    expect(core.flags & FLAG_NO_RETURN_PATH).not.toBe(0);
    core.setNetlist(net([guitarSrc('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 4700), R('R2', 'n2', 'gnd', 4700), probe('n2')]));
    expect(core.flags & FLAG_NO_RETURN_PATH).toBe(0); // resolved → badge no longer latched
    expect(dc(core, 2)).toBeCloseTo(1, 2); // and now it divides: 2 V × 4.7k/9.4k
  });

  it('the FLOATING badge reflects current state — it clears when the float is removed', () => {
    const floating = net([guitarSrc('S', 'n1', 'gnd'), R('R1', 'n1', 'n2', 1000), R('R2', 'n2', 'gnd', 1000), probe('n2'), R('STRAY', 'x', 'y', 1000)]);
    const core = new CircuitCore(floating);
    dc(core, 2);
    expect(core.flags & FLAG_FLOATING).not.toBe(0);
    core.setNetlist(net([guitarSrc('S', 'n1', 'gnd'), R('R1', 'n1', 'n2', 1000), R('R2', 'n2', 'gnd', 1000), probe('n2')]));
    dc(core, 2);
    expect(core.flags & FLAG_FLOATING).toBe(0); // resolved condition no longer latched
  });
});

const bjt = (id: string, c: string, b: string, e: string): ComponentSpec => ({ id, kind: 'bjt', pins: [c, b, e], params: { bjt: 'NPN' } });
const dcSrc = (id: string, hot: string, gnd: string, v: number): ComponentSpec => ({ id, kind: 'source', pins: [hot, gnd], params: { wave: 'dc', amp: v, rsrc: 1e-3 } });

describe('CircuitCore — BJT (Ebers-Moll) common-emitter amplifier', () => {
  // Vcc=9, base divider, Rc=4.7k, Re=1k (unbypassed) ⇒ mid-rail bias, gain ≈ −Rc/Re ≈ −4.7
  const ce = (): Netlist =>
    net([
      dcSrc('VCC', 'vcc', 'gnd', 9),
      guitarSrc('SIG', 'vin', 'gnd'),
      C('Cin', 'vin', 'base', 1e-6),
      R('R1', 'vcc', 'base', 47000),
      R('R2', 'base', 'gnd', 10000),
      R('Rc', 'vcc', 'col', 4700),
      R('Re', 'emit', 'gnd', 1000),
      bjt('Q', 'col', 'base', 'emit'),
      probe('col'),
    ]);

  it('biases to a sane DC operating point (collector mid-rail, BE junction conducting), fault-free', () => {
    const core = new CircuitCore(ce(), FS, { oversample: 1 });
    core.reset();
    const n = 6000; // let the input cap / bias settle
    core.processBlock(new Float64Array(n), new Float64Array(n), n);
    expect(core.nodeVoltage('col')).toBeGreaterThan(2.5); // active region…
    expect(core.nodeVoltage('col')).toBeLessThan(8); // …not slammed to a rail
    expect(core.nodeVoltage('base')).toBeGreaterThan(1.2);
    expect(core.nodeVoltage('emit')).toBeGreaterThan(0.4); // emitter lifts off ground ⇒ forward-active
    expect(core.flags & (FLAG_FLOATING | FLAG_NONFINITE)).toBe(0);
  });

  it('provides voltage gain ≫ 1 (collector AC swing several × the input)', () => {
    const core = new CircuitCore(ce(), FS, { oversample: 1 });
    core.reset();
    const N = 9600;
    const inb = new Float64Array(N);
    for (let i = 0; i < N; i++) inb[i] = 0.05 * Math.sin((2 * Math.PI * 500 * i) / FS);
    const out = new Float64Array(N);
    core.processBlock(inb, out, N);
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = N - 2400; i < N; i++) {
      if (out[i]! < mn) mn = out[i]!;
      if (out[i]! > mx) mx = out[i]!;
    }
    expect((mx - mn) / (2 * 0.05)).toBeGreaterThan(3); // a real boost (≈ Rc/Re ≈ 4.7×)
  });

  it('builds without a stamper throw and round-trips the bjt kind through getState', () => {
    const core = new CircuitCore(ce());
    expect(core.getState().components.some((c) => c.kind === 'bjt')).toBe(true);
  });
});

describe('CircuitCore — PNP transistor (the NPN mirror)', () => {
  const pnp = (id: string, c: string, b: string, e: string): ComponentSpec => ({ id, kind: 'bjt', pins: [c, b, e], params: { bjt: 'PNP' } });
  // PNP common-emitter off a NEGATIVE rail: bias ~−1.6 V, emitter sits ~0.65 V ABOVE base, collector mid-rail
  const cePnp = (): Netlist =>
    net([
      dcSrc('VEE', 'vee', 'gnd', -9),
      guitarSrc('SIG', 'vin', 'gnd'),
      C('Cin', 'vin', 'base', 1e-6),
      R('R1', 'vee', 'base', 47000),
      R('R2', 'base', 'gnd', 10000),
      R('Rc', 'vee', 'col', 4700),
      R('Re', 'emit', 'gnd', 1000),
      pnp('Q', 'col', 'base', 'emit'),
      probe('col'),
    ]);

  it('biases on a negative rail (emitter above base), collector mid-rail, fault-free', () => {
    const core = new CircuitCore(cePnp(), FS, { oversample: 1 });
    core.reset();
    const n = 6000;
    core.processBlock(new Float64Array(n), new Float64Array(n), n);
    const vc = core.nodeVoltage('col');
    const vb = core.nodeVoltage('base');
    const ve = core.nodeVoltage('emit');
    expect(vc).toBeLessThan(-2.5); // active region between the −9 V rail and ground
    expect(vc).toBeGreaterThan(-8);
    expect(ve).toBeGreaterThan(vb); // PNP: emitter sits ABOVE the base (Veb > 0 ⇒ forward)
    expect(ve - vb).toBeGreaterThan(0.4);
    expect(core.flags & (FLAG_FLOATING | FLAG_NONFINITE)).toBe(0);
  });

  it('amplifies (collector AC swing several × the input)', () => {
    const core = new CircuitCore(cePnp(), FS, { oversample: 1 });
    core.reset();
    const N = 9600;
    const inb = new Float64Array(N);
    for (let i = 0; i < N; i++) inb[i] = 0.05 * Math.sin((2 * Math.PI * 500 * i) / FS);
    const out = new Float64Array(N);
    core.processBlock(inb, out, N);
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = N - 2400; i < N; i++) {
      if (out[i]! < mn) mn = out[i]!;
      if (out[i]! > mx) mx = out[i]!;
    }
    expect((mx - mn) / (2 * 0.05)).toBeGreaterThan(3); // ≈ Rc/Re ≈ 4.7×
  });
});
