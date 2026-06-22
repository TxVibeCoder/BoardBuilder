import { describe, expect, it } from 'vitest';
import { makeBoard } from '../../src/ui/board/boardBuild';
import { toNetlist } from '../../src/ui/board/boardModel';

/**
 * makeBoard should produce the same BoardState a hand-author would write: parts with merged params,
 * one jumper per wire, and a netlist whose eyelets reflect the wired topology.
 */
describe('makeBoard', () => {
  // A voltage divider: SRC.hot — R1 — (mid) — R2 — gnd, probing the mid node.
  const board = makeBoard(
    [
      { id: 'SRC', kind: 'source', x: 12, y: 38, params: { wave: 'guitar', amp: 1 } },
      { id: 'R1', kind: 'resistor', x: 44, y: 26, params: { R: 10000 } },
      { id: 'R2', kind: 'resistor', x: 44, y: 56, params: { R: 20000 } },
      { id: 'PRB', kind: 'probe', x: 120, y: 36 },
    ],
    [
      ['SRC', 'hot', 'R1', 'a'], // vin
      ['R1', 'b', 'R2', 'a'], // mid
      ['R1', 'b', 'PRB', 'tip'], // probe the mid node
      ['R2', 'b', 'SRC', 'gnd'], // ground return
    ],
  );

  it('appends one jumper per wire with ids W1..', () => {
    const jumpers = board.components.filter((c) => c.kind === 'jumper');
    expect(jumpers.map((j) => j.id)).toEqual(['W1', 'W2', 'W3', 'W4']);
    // each jumper bridges two pin refs
    for (const j of jumpers) {
      expect(j.link).toBeDefined();
      expect(typeof j.link!.a.pinIndex).toBe('number');
      expect(typeof j.link!.b.pinIndex).toBe('number');
    }
  });

  it('merges param overrides over defaults', () => {
    const r2 = board.components.find((c) => c.id === 'R2')!;
    expect(r2.params.R).toBe(20000);
    const src = board.components.find((c) => c.id === 'SRC')!;
    expect(src.params.wave).toBe('guitar');
    expect(src.params.rsrc).toBeDefined(); // default carried through
  });

  it('resolves pin names to indices (R.a=0, R.b=1)', () => {
    const w1 = board.components.find((c) => c.id === 'W1')!;
    // SRC.hot → R1.a (resistor pin 'a' is index 0)
    expect(w1.link!.b).toEqual({ componentId: 'R1', pinIndex: 0 });
  });

  it('derives a netlist whose divider nodes collapse correctly', () => {
    const nl = toNetlist(board);
    const byId = new Map(nl.components.map((c) => [c.id, c]));

    // Wires here are JUMPERS (logical edges): each leg keeps its own geometric eyelet and the jumper
    // bridges two of them. So resolve the true electrical nets by union-find over the jumper edges.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (a: string, b: string): void => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      parent.set(find(a), find(b));
    };
    for (const c of nl.components) if (c.kind === 'jumper') union(c.pins[0]!, c.pins[1]!);

    const r1 = byId.get('R1')!;
    const r2 = byId.get('R2')!;
    const src = byId.get('SRC')!;
    const prb = byId.get('PRB')!;

    // vin net: SRC.hot ~ R1.a
    expect(find(src.pins[0]!)).toBe(find(r1.pins[0]!));
    // mid net: R1.b ~ R2.a ~ PRB.tip ~ probeEyelet
    expect(find(r1.pins[1]!)).toBe(find(r2.pins[0]!));
    expect(find(r1.pins[1]!)).toBe(find(prb.pins[0]!));
    expect(find(r1.pins[1]!)).toBe(find(nl.probeEyelet!));
    // gnd net: R2.b ~ SRC.gnd ~ groundEyelet
    expect(find(r2.pins[1]!)).toBe(find(src.pins[1]!));
    expect(find(r2.pins[1]!)).toBe(find(nl.groundEyelet!));

    // exactly three distinct electrical nets: vin, mid, gnd
    const nets = new Set([find(r1.pins[0]!), find(r1.pins[1]!), find(r2.pins[1]!)]);
    expect(nets.size).toBe(3);
  });

  it('honors a custom sample rate', () => {
    const b = makeBoard([{ id: 'P', kind: 'probe', x: 0, y: 0 }], [], 96000);
    expect(b.sampleRate).toBe(96000);
  });

  it('throws on an unknown pin name', () => {
    expect(() => makeBoard([{ id: 'R', kind: 'resistor', x: 0, y: 0 }], [['R', 'nope', 'R', 'a']])).toThrow(/no pin/);
  });
});
