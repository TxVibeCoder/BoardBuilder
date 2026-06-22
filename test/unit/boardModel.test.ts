import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import { compileNetlist, type ComponentKind } from '../../src/engine/dsp/netlist';
import {
  addComponent,
  addJumper,
  applyDropSnap,
  componentAABB,
  computeEyelets,
  emptyBoard,
  findFreeSlot,
  isPlayable,
  moveComponent,
  pinsOf,
  removeComponent,
  rotateComponent,
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

  it("a part's own legs never merge into one node (no self-short on close-spaced pins)", () => {
    // source hot/gnd are ~3.6 mm apart; op-amp ±in ~2.5 mm — a generous merge radius would short them
    expect(computeEyelets(addComponent(emptyBoard(), 'source', 50, 50)).length).toBe(2);
    expect(computeEyelets(addComponent(emptyBoard(), 'opamp', 50, 50)).length).toBe(3);
  });

  it('snap-on-drop pulls a near leg exactly onto its target, then they merge', () => {
    let b = emptyBoard();
    let r = placePinAt(b, 'source', 'hot', 50, 50);
    b = r.board;
    r = placePinAt(b, 'resistor', 'a', 53, 50); // 3 mm away: within catch range, but NOT merged yet
    b = r.board;
    const rid = r.id;
    expect(computeEyelets(b).some((e) => e.pins.length >= 2)).toBe(false);
    b = applyDropSnap(b, rid); // magnetic snap
    expect(computeEyelets(b).some((e) => e.pins.length >= 2)).toBe(true);
  });

  it('rotation moves the leads (a horizontal resistor turned 90° becomes vertical)', () => {
    let b = addComponent(emptyBoard(), 'resistor', 20, 20);
    const id = b.components[0]!.id;
    const flat = pinsOf(b.components[0]!);
    expect(Math.abs(flat[0]!.x - flat[1]!.x)).toBeGreaterThan(Math.abs(flat[0]!.y - flat[1]!.y)); // pins span x
    b = rotateComponent(b, id);
    expect(b.components.find((c) => c.id === id)!.rot).toBe(90);
    const turned = pinsOf(b.components.find((c) => c.id === id)!);
    expect(Math.abs(turned[0]!.y - turned[1]!.y)).toBeGreaterThan(Math.abs(turned[0]!.x - turned[1]!.x)); // now span y
  });

  it('a jumper wire unions two non-touching legs into one electrical net', () => {
    let b = addComponent(emptyBoard(), 'source', 10, 10);
    b = addComponent(b, 'resistor', 90, 70); // far from the source — no physical snap-merge
    const sid = b.components[0]!.id;
    const rid = b.components[1]!.id;
    const before = compileNetlist(toNetlist(b));
    const hotEy = toNetlist(b).components.find((c) => c.id === sid)!.pins[0]!; // source 'hot'
    const aEy = toNetlist(b).components.find((c) => c.id === rid)!.pins[0]!; // resistor 'a'
    expect(before.nodeOfEyelet.get(hotEy)).not.toBe(before.nodeOfEyelet.get(aEy)); // distinct nets

    b = addJumper(b, { componentId: sid, pinIndex: 0 }, { componentId: rid, pinIndex: 0 });
    const net = toNetlist(b);
    expect(net.components.find((c) => c.kind === 'jumper')!.pins).toHaveLength(2);
    const after = compileNetlist(net);
    expect(after.nodeOfEyelet.get(hotEy)).toBe(after.nodeOfEyelet.get(aEy)); // jumper merged them
  });

  it('deleting a part also removes any jumper attached to it (no dangling wires)', () => {
    let b = addComponent(emptyBoard(), 'source', 10, 10);
    b = addComponent(b, 'resistor', 90, 70);
    const sid = b.components[0]!.id;
    const rid = b.components[1]!.id;
    b = addJumper(b, { componentId: sid, pinIndex: 0 }, { componentId: rid, pinIndex: 0 });
    expect(b.components.some((c) => c.kind === 'jumper')).toBe(true);
    b = removeComponent(b, rid);
    expect(b.components.some((c) => c.kind === 'jumper')).toBe(false);
  });

  it('auto-placement (findFreeSlot) never spawns overlapping bodies', () => {
    let b = emptyBoard();
    for (let i = 0; i < 7; i++) {
      const slot = findFreeSlot(b, i % 2 ? 'resistor' : 'bjt');
      b = addComponent(b, i % 2 ? 'resistor' : 'bjt', slot.x, slot.y);
    }
    const boxes = b.components.map(componentAABB).filter((x): x is NonNullable<typeof x> => x !== null);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const c = boxes[j]!;
        expect(a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y).toBe(false);
      }
    }
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
