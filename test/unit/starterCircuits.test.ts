import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import { FLAG_OK } from '../../src/engine/dsp/mnaSystem';
import type { ComponentParams, ComponentSpec } from '../../src/engine/dsp/netlist';
import { STARTER_CIRCUITS, type StarterCircuit } from '../../src/data/starterCircuits';

const FS = 48000;

function byId(id: string): StarterCircuit {
  const c = STARTER_CIRCUITS.find((s) => s.id === id);
  if (!c) throw new Error(`no starter circuit '${id}'`);
  return c;
}

/** A param value that exists on a component spec (mirrors the netlist-as-truth read). */
function paramOf(c: StarterCircuit, componentId: string, key: keyof ComponentParams): number | undefined {
  const spec: ComponentSpec | undefined = c.netlist.components.find((s) => s.id === componentId);
  return spec?.params[key] as number | undefined;
}

/** Settle a DC `vin` through the guitar source and return the final probe voltage. */
function dc(core: CircuitCore, vin: number, n = 256): number {
  core.reset();
  const inb = new Float64Array(n).fill(vin);
  const out = new Float64Array(n);
  core.processBlock(inb, out, n);
  return out[n - 1]!;
}

/**
 * Steady-state magnitude response |H(freq)| of a guitar-driven circuit: drive a unit sine through
 * the external input and measure outRMS / inRMS. (The starter sources are wave:'guitar', so the
 * frequency comes from the fed input, not a source param.)
 */
function gainAt(core: CircuitCore, freq: number): number {
  core.reset();
  const period = FS / freq;
  const N = Math.ceil(8 * period + FS * 0.05);
  const inb = new Float64Array(N);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) inb[i] = Math.SQRT2 * Math.sin((2 * Math.PI * freq * i) / FS); // inRMS = 1
  core.processBlock(inb, out, N);
  const M = Math.floor(6 * period);
  let s = 0;
  for (let i = N - M; i < N; i++) s += out[i]! * out[i]!;
  return Math.sqrt(s / M); // |H| = outRMS / inRMS, inRMS = 1
}

describe('STARTER_CIRCUITS — the six §9 on-ramp demos', () => {
  it('is exactly the six, in difficulty order, with unique ids', () => {
    expect(STARTER_CIRCUITS).toHaveLength(6);
    expect(STARTER_CIRCUITS.map((c) => c.id)).toEqual([
      'divider',
      'rc-lowpass',
      'rc-highpass',
      'diode-clipper',
      'opamp-gain',
      'opamp-overdrive',
    ]);
    const ids = new Set(STARTER_CIRCUITS.map((c) => c.id));
    expect(ids.size).toBe(6);
  });

  it('every circuit carries teaching copy, 1–2 valid knobs, gnd + guitar source + probe', () => {
    for (const c of STARTER_CIRCUITS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.teaches.length).toBeGreaterThan(0);
      expect(c.tryThis.length).toBeGreaterThan(0);

      // 1–2 live knobs, each mapping to a real component param with min<max
      expect(c.knobs.length).toBeGreaterThanOrEqual(1);
      expect(c.knobs.length).toBeLessThanOrEqual(2);
      for (const k of c.knobs) {
        expect(k.min).toBeLessThan(k.max);
        expect(k.label.length).toBeGreaterThan(0);
        const spec = c.netlist.components.find((s) => s.id === k.componentId);
        expect(spec, `knob ${c.id}/${k.componentId} exists`).toBeDefined();
        // the targeted param is actually present on that component
        expect(spec!.params[k.param]).toBeDefined();
      }

      // ground eyelet
      expect(c.netlist.groundEyelet).toBe('gnd');
      // a guitar-wave source with a sane drive amplitude
      const src = c.netlist.components.find((s) => s.kind === 'source');
      expect(src, `${c.id} has a source`).toBeDefined();
      expect(src!.params.wave).toBe('guitar');
      expect(src!.params.amp!).toBeGreaterThanOrEqual(0.3);
      expect(src!.params.amp!).toBeLessThanOrEqual(2);
      // a probe component
      expect(c.netlist.components.some((s) => s.kind === 'probe')).toBe(true);
    }
  });

  it('every circuit constructs, solves finite, and raises no fault flag', () => {
    for (const c of STARTER_CIRCUITS) {
      const core = new CircuitCore(c.netlist);
      const out = new Float64Array(256);
      const inb = new Float64Array(256);
      for (let i = 0; i < 256; i++) inb[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS);
      core.processBlock(inb, out, 256);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
      expect(core.flags).toBe(FLAG_OK);
      expect(core.groundOk).toBe(true);
    }
  });

  it('§9.1 divider: V_out = V_in · R2/(R1+R2)', () => {
    const c = byId('divider');
    const core = new CircuitCore(c.netlist);
    const r1 = paramOf(c, 'R1', 'R')!;
    const r2 = paramOf(c, 'R2', 'R')!;
    const Vin = 1;
    expect(dc(core, Vin)).toBeCloseTo((Vin * r2) / (r1 + r2), 3); // 0.75 V
  });

  it('§9.2 RC low-pass: −3 dB at fc = 1/(2πRC), passband flat, highs roll off', () => {
    const c = byId('rc-lowpass');
    const core = new CircuitCore(c.netlist);
    const r = paramOf(c, 'R', 'R')!;
    const cap = paramOf(c, 'C', 'C')!;
    const fc = 1 / (2 * Math.PI * r * cap);
    expect(fc).toBeGreaterThan(800);
    expect(fc).toBeLessThan(1200);
    expect(gainAt(core, fc)).toBeCloseTo(0.707, 2);
    expect(gainAt(core, fc / 10)).toBeGreaterThan(0.95);
    expect(gainAt(core, fc * 10)).toBeLessThan(0.15);
  });

  it('§9.3 RC high-pass: −3 dB at fc, blocks lows, passes highs', () => {
    const c = byId('rc-highpass');
    const core = new CircuitCore(c.netlist);
    const r = paramOf(c, 'R', 'R')!;
    const cap = paramOf(c, 'C', 'C')!;
    const fc = 1 / (2 * Math.PI * r * cap);
    expect(gainAt(core, fc)).toBeCloseTo(0.707, 2);
    expect(gainAt(core, fc * 10)).toBeGreaterThan(0.9);
    expect(gainAt(core, fc / 20)).toBeLessThan(0.1);
  });

  it('§9.4 diode clipper: symmetric pair caps the swing near the Si forward drop', () => {
    const c = byId('diode-clipper');
    const core = new CircuitCore(c.netlist);
    const N = 2400;
    const inb = new Float64Array(N);
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) inb[i] = 2.0 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    core.processBlock(inb, out, N);
    let maxPos = -Infinity;
    let minNeg = Infinity;
    for (let i = 200; i < N; i++) {
      if (out[i]! > maxPos) maxPos = out[i]!;
      if (out[i]! < minNeg) minNeg = out[i]!;
    }
    // clamped near ±the Si knee (well below the 2 V drive); symmetric ⇒ both halves clip
    expect(maxPos).toBeLessThan(0.8);
    expect(maxPos).toBeGreaterThan(0.4);
    expect(minNeg).toBeGreaterThan(-0.8);
    expect(minNeg).toBeLessThan(-0.4);
  });

  it('§9.5 op-amp gain: small-signal slope ≈ 1 + Rf/Rg', () => {
    const c = byId('opamp-gain');
    const core = new CircuitCore(c.netlist);
    const rf = paramOf(c, 'Rf', 'R')!;
    const rg = paramOf(c, 'Rg', 'R')!;
    const amp = paramOf(c, 'S', 'amp')!; // the guitar source trims the fed input: Vs = fed · amp
    const gain = 1 + rf / rg; // ≈ 11
    expect(dc(core, 0.1)).toBeCloseTo(0.1 * amp * gain, 1);
    expect(dc(core, 0.05)).toBeCloseTo(0.05 * amp * gain, 1);
  });

  it('§9.6 op-amp soft-clip: clean ×(1+Rf/Rg) at tiny signal, compresses below the rails when driven', () => {
    const c = byId('opamp-overdrive');
    const core = new CircuitCore(c.netlist);
    const rf = paramOf(c, 'Rf', 'R')!;
    const rg = paramOf(c, 'Rg', 'R')!;
    const amp = paramOf(c, 'S', 'amp')!;
    const gain = 1 + rf / rg; // ≈ 11
    // slope measured against the EFFECTIVE input (fed · amp), since the source scales the drive
    expect(dc(core, 0.01) / (0.01 * amp)).toBeGreaterThan(gain * 0.85); // diodes not yet conducting
    const large = dc(core, 0.6);
    expect(large).toBeLessThan(2.0); // compressed far below the linear 0.3 · 11
    expect(large).toBeLessThan(8.9); // diodes clip — not the ±9 V rails
    expect(large).toBeGreaterThan(0.6 * amp); // still a boost above the signal that reached the circuit
  });
});
