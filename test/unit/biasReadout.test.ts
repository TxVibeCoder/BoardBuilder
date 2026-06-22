/**
 * Bias readout — the divider's DC operating point. On a prebuilt voltage divider (a DC rail through
 * R1 then R2 to ground) the mid node must settle at HALF the rail; the rail node sits at the rail and
 * the ground node at 0. Verifies the pure {@link computeBias} solve + that an ungrounded board reads [].
 */

import { describe, expect, it } from 'vitest';
import { computeBias } from '../../src/ui/board/biasReadout';
import {
  addJumper,
  computeEyelets,
  defaultParams,
  pinsOf,
  type BoardComponent,
  type BoardState,
} from '../../src/ui/board/boardModel';
import type { ComponentKind } from '../../src/engine/dsp/netlist';

const FS = 48000;

/** Local makeBoard (mirrors premadeBoards' helper): place parts, then jumper named pins together. */
function pinIndexByName(comp: BoardComponent, name: string): number {
  const idx = pinsOf(comp).findIndex((p) => p.name === name);
  if (idx < 0) throw new Error(`${comp.kind} ${comp.id} has no pin '${name}'`);
  return idx;
}

function makeBoard(
  parts: { id: string; kind: ComponentKind; x: number; y: number; params?: Record<string, unknown> }[],
  wires: [string, string, string, string][],
): BoardState {
  const components: BoardComponent[] = parts.map((p) => ({
    id: p.id,
    kind: p.kind,
    params: { ...defaultParams(p.kind), ...(p.params ?? {}) },
    x: p.x,
    y: p.y,
  }));
  let board: BoardState = { components, sampleRate: FS, nextId: 200 };
  const byId = new Map(components.map((c) => [c.id, c]));
  for (const [aId, aName, bId, bName] of wires) {
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;
    board = addJumper(
      board,
      { componentId: aId, pinIndex: pinIndexByName(a, aName) },
      { componentId: bId, pinIndex: pinIndexByName(b, bName) },
    );
  }
  return board;
}

/** A 10k/10k divider off a 6 V DC rail: SRC.hot — R1 — (mid) — R2 — SRC.gnd, probe the mid. */
function dividerBoard(): BoardState {
  return makeBoard(
    [
      { id: 'SRC', kind: 'source', x: 12, y: 38, params: { wave: 'dc', amp: 6 } },
      { id: 'R1', kind: 'resistor', x: 44, y: 26, params: { R: 10000 } },
      { id: 'R2', kind: 'resistor', x: 44, y: 56, params: { R: 10000 } },
      { id: 'PRB', kind: 'probe', x: 120, y: 36 },
    ],
    [
      ['SRC', 'hot', 'R1', 'a'], // vin (the rail)
      ['R1', 'b', 'R2', 'a'], // mid
      ['R1', 'b', 'PRB', 'tip'], // probe the mid node
      ['R2', 'b', 'SRC', 'gnd'], // ground return
    ],
  );
}

describe('computeBias — DC operating point', () => {
  it('reads the mid node of a 10k/10k divider at half the rail', () => {
    const board = dividerBoard();
    const bias = computeBias(board);
    expect(bias.length).toBeGreaterThan(0);

    // the probed mid eyelet (the one the probe's tip pin joined) should be ~half the 6 V rail
    const eyelets = computeEyelets(board);
    const prbPin = pinsOf(board.components.find((c) => c.id === 'PRB')!)[0]!;
    const midEyelet = eyelets.find((e) => e.pins.some((p) => p.componentId === 'PRB' && p.pinIndex === prbPin.pinIndex))!;
    const mid = bias.find((b) => b.eyeletId === midEyelet.id)!;
    expect(mid.volts).toBeCloseTo(3, 1); // 6 V · 10k/(10k+10k) = 3 V

    // every eyelet got a readout, each placed at its centroid
    expect(bias.length).toBe(eyelets.length);
    for (const b of bias) {
      const e = eyelets.find((x) => x.id === b.eyeletId)!;
      expect(b.x).toBe(e.x);
      expect(b.y).toBe(e.y);
    }

    // the rail and ground rails bracket the mid: one ~6 V, one ~0 V
    const volts = bias.map((b) => b.volts).sort((a, c) => a - c);
    expect(volts[0]).toBeCloseTo(0, 1);
    expect(volts[volts.length - 1]).toBeCloseTo(6, 1);
  });

  it('returns [] when there is no ground reference (empty board ⇒ !groundOk)', () => {
    // an empty board has no nets ⇒ compileNetlist groundOk === false ⇒ no meaningful absolute voltages
    const board: BoardState = { components: [], sampleRate: FS, nextId: 1 };
    expect(computeBias(board)).toEqual([]);
  });
});
