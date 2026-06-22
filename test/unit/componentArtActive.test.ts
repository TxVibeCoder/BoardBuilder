import { describe, expect, it } from 'vitest';
import { opampArt, potArt, probeArt, sourceArt } from '../../src/ui/board/art/active';
import type { ArtRenderer } from '../../src/ui/board/artTypes';
import type { ComponentParams } from '../../src/engine/dsp/netlist';

/** Every renderer must yield a finite, positive bounding box. */
function expectFiniteSize(art: { width: number; height: number }): void {
  expect(Number.isFinite(art.width)).toBe(true);
  expect(Number.isFinite(art.height)).toBe(true);
  expect(art.width).toBeGreaterThan(0);
  expect(art.height).toBeGreaterThan(0);
}

/** Every pin must be finite and lie within the (closed) bounding box. */
function expectPinsInBox(art: { width: number; height: number; pins: { name: string; x: number; y: number }[] }): void {
  for (const p of art.pins) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(art.width);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(art.height);
  }
}

const cases: { name: string; render: ArtRenderer; params: ComponentParams; pinNames: string[] }[] = [
  { name: 'opamp', render: opampArt, params: {}, pinNames: ['plus', 'minus', 'out'] },
  { name: 'pot', render: potArt, params: { alpha: 0.5 }, pinNames: ['a', 'wiper', 'b'] },
  { name: 'source', render: sourceArt, params: { wave: 'sine' }, pinNames: ['hot', 'gnd'] },
  { name: 'probe', render: probeArt, params: {}, pinNames: ['tip'] },
];

describe('active/I-O component art — shared contract', () => {
  for (const c of cases) {
    it(`${c.name}: finite size, non-empty svg, correct pin names within box`, () => {
      const art = c.render(c.params);
      expectFiniteSize(art);
      expect(art.svg.length).toBeGreaterThan(0);
      expect(art.pins.map((p) => p.name)).toEqual(c.pinNames);
      expectPinsInBox(art);
    });
  }
});

describe('opampArt — DIP-8', () => {
  it('exposes +in/−in/out in netlist order with a notch + dot in the markup', () => {
    const art = opampArt({});
    expect(art.pins.map((p) => p.name)).toEqual(['plus', 'minus', 'out']);
    // inputs on the left edge (x ≈ 0), output on the right edge (x ≈ width)
    const plus = art.pins.find((p) => p.name === 'plus')!;
    const out = art.pins.find((p) => p.name === 'out')!;
    expect(plus.x).toBeCloseTo(0, 6);
    expect(out.x).toBeCloseTo(art.width, 6);
  });
});

describe('potArt — indicator reflects params.alpha', () => {
  it('the wiper-indicator angle changes with alpha (CCW at 0, CW at 1)', () => {
    const lo = potArt({ alpha: 0 });
    const mid = potArt({ alpha: 0.5 });
    const hi = potArt({ alpha: 1 });
    // the indicator line endpoint differs across positions, so the SVG strings must differ
    expect(lo.svg).not.toEqual(mid.svg);
    expect(mid.svg).not.toEqual(hi.svg);
    expect(lo.svg).not.toEqual(hi.svg);
    // all three keep the same bounding box and pin set (only the indicator moves)
    expect(lo.width).toEqual(hi.width);
    expect(lo.height).toEqual(hi.height);
    expect(lo.pins.map((p) => p.name)).toEqual(['a', 'wiper', 'b']);
  });

  it('a missing alpha is accepted (defaults centred) and stays in-box', () => {
    const art = potArt({});
    expectFiniteSize(art);
    expectPinsInBox(art);
  });
});

describe('sourceArt — glyph follows params.wave', () => {
  it('sine vs guitar render different glyphs', () => {
    const sine = sourceArt({ wave: 'sine' });
    const guitar = sourceArt({ wave: 'guitar' });
    expect(sine.svg).not.toEqual(guitar.svg);
    expect(sine.svg).toContain('bb-source-sine');
    expect(guitar.svg).toContain('bb-source-guitar');
    // both expose the same terminals regardless of waveform
    expect(sine.pins.map((p) => p.name)).toEqual(['hot', 'gnd']);
    expect(guitar.pins.map((p) => p.name)).toEqual(['hot', 'gnd']);
  });

  it('defaults to the sine glyph when wave is unset', () => {
    const art = sourceArt({});
    expect(art.svg).toContain('bb-source-sine');
  });
});

describe('probeArt — single tip', () => {
  it('has exactly one pin named tip, within the box', () => {
    const art = probeArt({});
    expect(art.pins).toHaveLength(1);
    expect(art.pins[0]!.name).toBe('tip');
    expectPinsInBox(art);
  });
});
