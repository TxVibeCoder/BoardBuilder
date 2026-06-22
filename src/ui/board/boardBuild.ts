/**
 * boardBuild — a reusable builder that turns placed parts + named-pin wires into a {@link BoardState}.
 *
 * Hand-authoring a board literal (placed components plus a jumper per connection, each jumper carrying
 * raw pin INDICES) is tedious and brittle: pin order is implicit and changes with art. {@link makeBoard}
 * lets callers describe a circuit declaratively — list the parts, then the wires as
 * `[compA, pinNameA, compB, pinNameB]` — and resolves each art pin NAME to its netlist pin index for
 * you, merging per-part param overrides over {@link defaultParams}. Every wire becomes one `jumper`
 * component (ids `W1..`), exactly as the Build canvas would after the user drops the wire, so
 * `toNetlist(board)` derives the same engine netlist as a hand-built board.
 *
 * Pure data — no Web Audio, no DOM. Used by `premadeBoards.ts` and any other premade BoardState.
 */

import { COMPONENT_ART } from './componentArt';
import { defaultParams, type BoardComponent, type BoardState, type PinRef } from './boardModel';
import type { ComponentKind, ComponentParams } from '../../engine/dsp/netlist';

/** A placed component: kind + body position (mm), optional rotation and param overrides. */
export interface PartSpec {
  id: string;
  kind: ComponentKind;
  x: number;
  y: number;
  rot?: number;
  params?: ComponentParams;
}

/** A wire: [componentA, pinNameA, componentB, pinNameB] — connects two legs by their art pin names. */
export type WireSpec = [string, string, string, string];

const FS = 48000;

/** Resolve an art pin name → its netlist pin index for a given kind+params. */
function pinIndexByName(kind: ComponentKind, params: ComponentParams, name: string): number {
  const art = COMPONENT_ART[kind]?.(params);
  const idx = art ? art.pins.findIndex((p) => p.name === name) : -1;
  if (idx < 0) throw new Error(`makeBoard: ${kind} has no pin '${name}'`);
  return idx;
}

/**
 * Build a {@link BoardState} from placed parts + named-pin wires. Each part gets `defaultParams(kind)`
 * with its overrides merged on top; each wire is appended as a `jumper` component (`W1..`) bridging the
 * two named legs (a logical edge — `toNetlist` unions their eyelets).
 */
export function makeBoard(parts: PartSpec[], wires: WireSpec[], sampleRate = FS): BoardState {
  const components: BoardComponent[] = parts.map((p) => ({
    id: p.id,
    kind: p.kind,
    params: { ...defaultParams(p.kind), ...(p.params ?? {}) },
    x: p.x,
    y: p.y,
    rot: p.rot,
  }));
  const byId = new Map(components.map((c) => [c.id, c]));
  const ref = (compId: string, pinName: string): PinRef => {
    const c = byId.get(compId);
    if (!c) throw new Error(`makeBoard: no component '${compId}'`);
    return { componentId: compId, pinIndex: pinIndexByName(c.kind, c.params, pinName) };
  };
  wires.forEach((w, i) => {
    components.push({ id: `W${i + 1}`, kind: 'jumper', params: {}, x: 0, y: 0, link: { a: ref(w[0], w[1]), b: ref(w[2], w[3]) } });
  });
  return { components, sampleRate, nextId: 200 };
}
