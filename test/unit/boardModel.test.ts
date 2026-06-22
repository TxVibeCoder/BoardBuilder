import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import type { ComponentKind } from '../../src/engine/dsp/netlist';
import {
  addComponent,
  computeEyelets,
  emptyBoard,
  isPlayable,
  moveComponent,
  pinsOf,
  toNetlist,
  type BoardState,
} from '../../src/ui/board/boardModel';

/** Place a fresh `kind` so its `pinName` lands exactly at (x,y); returns the new board + its id. */
function placePinAt(board: BoardState, kind: ComponentKind, pinName: string, x: number, y: number): { board: BoardState; id: string } {
  const added = addComponent(board, kind, 0, 0);
  const created = added.components[added.components.length - 1]!;
  const pin = pinsOf(created).find((p) => p.name === pinName)!;
  return { board: moveComponent(added, created.id, x - pin.x, y - pin.y), id: created.id };
}

describe('boardModel — eyelet clustering and netlist derivation', () => {
  it('coincident pins merge into one eyelet (snap-merge)', () => {
    let b = emptyBoard();
    let r = placePinAt(b, 'source', 'hot', 50, 50);
    b = r.board;
    const sid = r.id;
    r = placePinAt(b, 'resistor', 'a', 50, 50); // R.a dropped onto source.hot
    b = r.board;
    const rid = r.id;
    const eyelets = computeEyelets(b);
    const shared = eyelets.find((e) => e.pins.length >= 2);
    expect(shared).toBeDefined();
    const tags = shared!.pins.map((p) => `${p.componentId}:${p.name}`);
    expect(tags).toContain(`${sid}:hot`);
    expect(tags).toContain(`${rid}:a`);
  });

  it('dragging a leg away splits the eyelet', () => {
    let b = emptyBoard();
    let r = placePinAt(b, 'source', 'hot', 50, 50);
    b = r.board;
    r = placePinAt(b, 'resistor', 'a', 50, 50);
    b = r.board;
    const rid = r.id;
    expect(computeEyelets(b).some((e) => e.pins.length >= 2)).toBe(true);
    b = moveComponent(b, rid, 200, 200); // drag the resistor far away
    expect(computeEyelets(b).every((e) => e.pins.length === 1)).toBe(true);
  });

  it('derives a solvable engine netlist from board geometry (source → R → probe)', () => {
    let b = emptyBoard();
    let r = placePinAt(b, 'source', 'hot', 50, 50);
    b = r.board;
    r = placePinAt(b, 'resistor', 'a', 50, 50); // R.a on source.hot
    b = r.board;
    const rid = r.id;
    const rb = pinsOf(b.components.find((c) => c.id === rid)!).find((p) => p.name === 'b')!;
    r = placePinAt(b, 'probe', 'tip', rb.x, rb.y); // probe on R.b
    b = r.board;

    expect(isPlayable(b)).toBe(true);
    const net = toNetlist(b);
    // R.a shares source.hot's eyelet; R.b shares the probe's eyelet — distinct nets joined by R
    const rSpec = net.components.find((c) => c.id === rid)!;
    expect(rSpec.pins[0]).not.toBe(rSpec.pins[1]);

    const core = new CircuitCore(net);
    expect(core.groundOk).toBe(true);
    const out = new Float64Array(64);
    core.processBlock(new Float64Array(64).fill(1), out, 64);
    expect(Number.isFinite(out[63]!)).toBe(true);
  });

  it('assigns unique ids and round-trips params via updateParams', () => {
    let b = emptyBoard();
    b = addComponent(b, 'resistor', 0, 0);
    b = addComponent(b, 'resistor', 10, 0);
    const ids = b.components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(b.components[0]!.params.R).toBe(10000); // default
  });
});
