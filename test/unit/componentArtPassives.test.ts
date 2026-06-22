import { describe, expect, it } from 'vitest';
import { DIODE_MODELS } from '../../src/engine/dsp/constants';
import type { ComponentParams } from '../../src/engine/dsp/netlist';
import type { ArtRenderer } from '../../src/ui/board/artTypes';
import { capacitorArt, diodeArt, resistorArt, resistorColorCode } from '../../src/ui/board/art/passives';

/** A renderer must return a finite box, a non-empty svg, and pins inside (or on) that box. */
function expectWellFormed(render: ArtRenderer, params: ComponentParams, expectedPins: string[]): void {
  const art = render(params);
  expect(Number.isFinite(art.width)).toBe(true);
  expect(Number.isFinite(art.height)).toBe(true);
  expect(art.width).toBeGreaterThan(0);
  expect(art.height).toBeGreaterThan(0);
  expect(typeof art.svg).toBe('string');
  expect(art.svg.length).toBeGreaterThan(0);
  expect(art.pins.map((p) => p.name)).toEqual(expectedPins);
  const eps = 1e-9;
  for (const p of art.pins) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(-eps);
    expect(p.x).toBeLessThanOrEqual(art.width + eps);
    expect(p.y).toBeGreaterThanOrEqual(-eps);
    expect(p.y).toBeLessThanOrEqual(art.height + eps);
  }
}

describe('passives art — resistorArt', () => {
  it('is well-formed with pins a,b on the lead tips', () => {
    expectWellFormed(resistorArt, { R: 1000 }, ['a', 'b']);
    const art = resistorArt({ R: 1000 });
    // leads run the full width; pins sit at the two tips.
    expect(art.pins[0]!.x).toBeCloseTo(0, 6);
    expect(art.pins[1]!.x).toBeCloseTo(art.width, 6);
  });

  it('renders four color bands whose markup changes with R (1k vs 100k)', () => {
    const a = resistorArt({ R: 1000 }).svg;
    const b = resistorArt({ R: 100000 }).svg;
    expect(a).not.toEqual(b);
    // four band <rect> elements present
    expect((a.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('handles a missing / zero / non-finite R without producing NaN markup', () => {
    for (const p of [{}, { R: 0 }, { R: -5 }, { R: Number.NaN }] as ComponentParams[]) {
      const art = resistorArt(p);
      expect(art.svg).not.toMatch(/NaN/);
      expect(Number.isFinite(art.width)).toBe(true);
    }
  });
});

describe('passives art — resistorColorCode', () => {
  it('decodes standard values to digit/digit/multiplier indices', () => {
    expect(resistorColorCode(1000)).toMatchObject({ d1: 1, d2: 0, mult: 2 }); // brown black red
    expect(resistorColorCode(100000)).toMatchObject({ d1: 1, d2: 0, mult: 4 }); // brown black yellow
    expect(resistorColorCode(220)).toMatchObject({ d1: 2, d2: 2, mult: 1 }); // red red brown
    expect(resistorColorCode(4700)).toMatchObject({ d1: 4, d2: 7, mult: 2 }); // yellow violet red
    expect(resistorColorCode(47)).toMatchObject({ d1: 4, d2: 7, mult: 0 }); // yellow violet black
  });

  it('keeps every band index inside the 0..9 palette range', () => {
    for (const r of [1, 47, 220, 1000, 4700, 100000, 1e6, 1e7]) {
      const b = resistorColorCode(r);
      for (const i of [b.d1, b.d2, b.mult]) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThanOrEqual(9);
      }
    }
  });
});

describe('passives art — capacitorArt', () => {
  it('film box (no polarity) is well-formed with pins a,b', () => {
    expectWellFormed(capacitorArt, { C: 1e-7 }, ['a', 'b']);
  });

  it('electrolytic (polarity) is well-formed and larger for bigger C', () => {
    expectWellFormed(capacitorArt, { C: 1e-5, polarity: true }, ['a', 'b']);
    const small = capacitorArt({ C: 1e-6, polarity: true });
    const big = capacitorArt({ C: 1e-3, polarity: true });
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
  });

  it('film and electrolytic produce visibly different markup', () => {
    const film = capacitorArt({ C: 1e-6 }).svg;
    const elec = capacitorArt({ C: 1e-6, polarity: true }).svg;
    expect(film).not.toEqual(elec);
    expect(elec).toMatch(/<circle/); // can body
    expect(film).not.toMatch(/<circle/); // box body
  });
});

describe('passives art — diodeArt', () => {
  it('Si diode is well-formed with pins a,k and a cathode band', () => {
    expectWellFormed(diodeArt, { diode: 'Si' }, ['a', 'k']);
  });

  it('tint differs by chemistry, and the LED body differs from the glass diode', () => {
    const si = diodeArt({ diode: 'Si' }).svg;
    const ge = diodeArt({ diode: 'Ge' }).svg;
    const led = diodeArt({ diode: 'LED' }).svg;
    expect(si).not.toEqual(ge); // chemistry tint
    expect(led).not.toEqual(si); // domed LED body vs axial glass
    // the LED is drawn larger than the axial diode body
    expect(diodeArt({ diode: 'LED' }).height).toBeGreaterThan(diodeArt({ diode: 'Si' }).height);
  });

  it('defaults to Si when params.diode is absent', () => {
    expect(diodeArt({}).svg).toEqual(diodeArt({ diode: 'Si' }).svg);
    // sanity: the model table the art tints from has the three teaching parts
    expect(Object.keys(DIODE_MODELS).sort()).toEqual(['Ge', 'LED', 'Si']);
  });
});
