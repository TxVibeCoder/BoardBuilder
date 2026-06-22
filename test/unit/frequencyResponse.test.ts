import { describe, expect, it } from 'vitest';
import { frequencyResponse } from '../../src/engine/dsp/frequencyResponse';
import type { ComponentSpec, Netlist } from '../../src/engine/dsp/netlist';

const FS = 48000;

function net(components: ComponentSpec[], extra: Partial<Netlist> = {}): Netlist {
  return { components, sampleRate: FS, groundEyelet: 'gnd', ...extra };
}
const R = (id: string, a: string, b: string, ohms: number): ComponentSpec => ({ id, kind: 'resistor', pins: [a, b], params: { R: ohms } });
const C = (id: string, a: string, b: string, farads: number): ComponentSpec => ({ id, kind: 'capacitor', pins: [a, b], params: { C: farads } });
const probe = (n: string): ComponentSpec => ({ id: 'PROBE', kind: 'probe', pins: [n], params: {} });
// a placeholder source — frequencyResponse forces it to wave:'sine' at each swept frequency
const src = (id: string, hot: string, gnd: string): ComponentSpec => ({ id, kind: 'source', pins: [hot, gnd], params: { wave: 'sine', amp: 1, freq: 1000, rsrc: 1e-6 } });

// R = 1591.55 Ω, C = 100 nF ⇒ fc = 1/(2πRC) = 1000 Hz
const rcLowPass = (): Netlist => net([src('S', 'n1', 'gnd'), R('R', 'n1', 'n2', 1591.55), C('C', 'n2', 'gnd', 1e-7), probe('n2')]);

function nearest(points: { hz: number }[], hz: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.hz - hz) < Math.abs(points[best]!.hz - hz)) best = i;
  return best;
}

describe('frequencyResponse — pure offline magnitude sweep', () => {
  it('defaults: ~60 log-spaced points spanning 20 Hz..20 kHz', () => {
    const resp = frequencyResponse(rcLowPass());
    expect(resp.length).toBe(60);
    expect(resp[0]!.hz).toBeCloseTo(20, 6);
    expect(resp[resp.length - 1]!.hz).toBeCloseTo(20000, 0);
    // log spacing ⇒ a (roughly) constant ratio between consecutive frequencies
    const r1 = resp[1]!.hz / resp[0]!.hz;
    const r2 = resp[2]!.hz / resp[1]!.hz;
    expect(r2 / r1).toBeCloseTo(1, 3);
    // db is consistent with gain on every point
    for (const p of resp) expect(p.db).toBeCloseTo(20 * Math.log10(Math.max(p.gain, 1e-12)), 6);
  });

  it('RC low-pass is ~-3 dB at the 1 kHz corner', () => {
    // sweep a fine band straddling the corner so a swept point lands near 1 kHz
    const resp = frequencyResponse(rcLowPass(), { fMin: 500, fMax: 2000, points: 41 });
    const i = nearest(resp, 1000);
    expect(resp[i]!.hz).toBeCloseTo(1000, -2); // a point lands near the corner
    expect(resp[i]!.gain).toBeCloseTo(0.707, 2); // |H| = 1/√2
    expect(resp[i]!.db).toBeCloseTo(-3, 0); // ≈ −3 dB
  });

  it('RC low-pass passes lows, rolls off highs (monotone falling), ~ -20 dB/decade above', () => {
    const resp = frequencyResponse(rcLowPass());
    const lo = resp[nearest(resp, 100)]!;
    const hi = resp[nearest(resp, 10000)]!;
    expect(lo.gain).toBeGreaterThan(0.95); // passband ≈ unity well below the corner
    expect(hi.gain).toBeLessThan(0.15); // strongly attenuated a decade above

    // monotonically non-increasing across the whole sweep (a clean single-pole rolloff)
    for (let k = 1; k < resp.length; k++) expect(resp[k]!.gain).toBeLessThanOrEqual(resp[k - 1]!.gain + 1e-3);

    // first-order slope: a decade above the corner is ≈ −20 dB relative to the corner
    const corner = frequencyResponse(rcLowPass(), { fMin: 1000, fMax: 10000, points: 2 });
    expect(corner[1]!.db - corner[0]!.db).toBeLessThan(-15); // ≈ −20 dB/decade
    expect(corner[1]!.db - corner[0]!.db).toBeGreaterThan(-25);
  });

  it('does not mutate the input netlist', () => {
    const original = rcLowPass();
    const before = JSON.stringify(original);
    frequencyResponse(original, { points: 8 });
    expect(JSON.stringify(original)).toBe(before);
  });
});
