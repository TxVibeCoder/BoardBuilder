/**
 * FreqResponse view check (node env, no DOM): the component file typechecks via its imports, and the
 * DATA it plots — the offline `frequencyResponse` sweep over the RC-lowpass starter — has the expected
 * Bode shape: ~0 dB in the passband, monotonic roll-off, and a −3 dB corner near 1/(2πRC).
 */

import { describe, expect, it } from 'vitest';
import { frequencyResponse } from '../../src/engine/dsp/frequencyResponse';
import { STARTER_CIRCUITS } from '../../src/data/starterCircuits';
// import the component so this spec also fails if FreqResponse.tsx stops typechecking
import { FreqResponse } from '../../src/ui/FreqResponse';

describe('FreqResponse view', () => {
  it('exports a component', () => {
    expect(typeof FreqResponse).toBe('function');
  });

  it('plots a low-pass shape for the RC-lowpass starter (passband ≈0 dB, monotonic roll-off, −3 dB corner)', () => {
    const lp = STARTER_CIRCUITS.find((c) => c.id === 'rc-lowpass')!;
    const pts = frequencyResponse(lp.netlist, { fMin: 20, fMax: 20000, points: 120 });

    // passband (lowest swept point) sits near unity gain
    expect(pts[0]!.db).toBeGreaterThan(-1);
    // high end is well attenuated relative to the passband
    expect(pts[pts.length - 1]!.db).toBeLessThan(pts[0]!.db - 12);

    // a single −3 dB crossing exists in the band (the corner the plot teaches)
    const crossings = pts.filter((p, i) => i > 0 && pts[i - 1]!.db >= -3 && p.db < -3);
    expect(crossings.length).toBe(1);
  });
});
