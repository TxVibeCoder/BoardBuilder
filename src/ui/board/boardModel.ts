/**
 * Board model — the eyelet board's source of truth, and the PURE function that turns board geometry
 * into an engine {@link Netlist} (work order §3: eyelet = node, component = edge, netlist derived from
 * the board, renderer a pure function of it).
 *
 * The interaction is freeform (no grid): a component sits at a body position; its pins land at the
 * art's lead anchors. Pins whose absolute positions fall within {@link SNAP_MM} cluster into ONE
 * eyelet (= one electrical node) — that is the snap-merge. Drag a leg away and the cluster splits.
 * A lone pin is its own eyelet (a floating/unconnected node — itself legible). No Web Audio, no DOM.
 */

import type { ComponentKind, ComponentParams, ComponentSpec, Netlist } from '../../engine/dsp/netlist';
import { COMPONENT_ART } from './componentArt';

/** Magnetic CATCH range (mm): dropping a leg within this of another snaps it exactly onto it. Generous
 *  so hand-dragging legs together is forgiving — "drag a leg near another → they click together". */
export const SNAP_MM = 5;

/** MERGE tolerance (mm): two pins become one eyelet (node) only when essentially coincident. Kept tiny
 *  (well below any part's own inter-leg spacing) so connections happen ONLY via the exact snap-on-drop —
 *  a generous merge radius would short a part's own closely-spaced legs (source hot/gnd, op-amp ±in). */
export const MERGE_MM = 0.6;

export interface BoardComponent {
  id: string;
  kind: ComponentKind;
  params: ComponentParams;
  x: number; // body origin (mm)
  y: number;
}

export interface BoardState {
  components: BoardComponent[];
  sampleRate: number;
  nextId: number;
}

export interface BoardPin {
  componentId: string;
  pinIndex: number;
  name: string;
  x: number; // absolute (mm)
  y: number;
}

export interface BoardEyelet {
  id: string;
  x: number; // centroid (mm)
  y: number;
  pins: BoardPin[];
}

const PREFIX: Partial<Record<ComponentKind, string>> = {
  resistor: 'R',
  capacitor: 'C',
  inductor: 'L',
  diode: 'D',
  opamp: 'U',
  pot: 'POT',
  source: 'SRC',
  probe: 'PRB',
};

const DEFAULTS: Partial<Record<ComponentKind, ComponentParams>> = {
  resistor: { R: 10000 },
  capacitor: { C: 1e-7 },
  inductor: { L: 1e-3 },
  diode: { diode: 'Si', symmetric: true },
  opamp: { vsat: 9 },
  pot: { alpha: 0.5, potR: 10000 },
  source: { wave: 'guitar', amp: 1, rsrc: 1e-6 },
  probe: {},
};

export function emptyBoard(sampleRate = 48000): BoardState {
  return { components: [], sampleRate, nextId: 1 };
}

export function defaultParams(kind: ComponentKind): ComponentParams {
  return { ...(DEFAULTS[kind] ?? {}) };
}

export function addComponent(board: BoardState, kind: ComponentKind, x: number, y: number): BoardState {
  const id = `${PREFIX[kind] ?? 'X'}${board.nextId}`;
  const comp: BoardComponent = { id, kind, params: defaultParams(kind), x, y };
  return { ...board, components: [...board.components, comp], nextId: board.nextId + 1 };
}

export function moveComponent(board: BoardState, id: string, x: number, y: number): BoardState {
  return { ...board, components: board.components.map((c) => (c.id === id ? { ...c, x, y } : c)) };
}

export function removeComponent(board: BoardState, id: string): BoardState {
  return { ...board, components: board.components.filter((c) => c.id !== id) };
}

export function updateParams(board: BoardState, id: string, params: Partial<ComponentParams>): BoardState {
  return {
    ...board,
    components: board.components.map((c) => (c.id === id ? { ...c, params: { ...c.params, ...params } } : c)),
  };
}

/** Absolute pin positions for one component (empty if the kind has no art). */
export function pinsOf(comp: BoardComponent): BoardPin[] {
  const art = COMPONENT_ART[comp.kind];
  if (!art) return [];
  return art(comp.params).pins.map((p, i) => ({
    componentId: comp.id,
    pinIndex: i,
    name: p.name,
    x: comp.x + p.x,
    y: comp.y + p.y,
  }));
}

export function allPins(board: BoardState): BoardPin[] {
  return board.components.flatMap(pinsOf);
}

const pinKey = (p: BoardPin): string => `${p.componentId}:${p.pinIndex}`;

/** Cluster every pin into eyelets by proximity (union-find, distance ≤ SNAP_MM). Deterministic order. */
export function computeEyelets(board: BoardState): BoardEyelet[] {
  const pins = allPins(board);
  const n = pins.length;
  const parent = pins.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    let cur = i;
    while (parent[cur] !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const r2 = MERGE_MM * MERGE_MM;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pins[i]!.componentId === pins[j]!.componentId) continue; // a part's own legs are never one node
      const dx = pins[i]!.x - pins[j]!.x;
      const dy = pins[i]!.y - pins[j]!.y;
      if (dx * dx + dy * dy <= r2) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const groups = new Map<number, BoardPin[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = [];
      groups.set(r, g);
    }
    g.push(pins[i]!);
  }
  // deterministic eyelet ids: sort clusters by their lexicographically-smallest pin key
  const clusters = [...groups.values()].sort((a, b) =>
    a.map(pinKey).sort()[0]!.localeCompare(b.map(pinKey).sort()[0]!),
  );
  return clusters.map((g, idx) => {
    let cx = 0;
    let cy = 0;
    for (const p of g) {
      cx += p.x;
      cy += p.y;
    }
    return { id: `e${idx}`, x: cx / g.length, y: cy / g.length, pins: g };
  });
}

/** Derive the engine netlist from the board (pure). Pins → eyelet ids; ground = the source's 'gnd'
 *  pin's eyelet, probe = the probe component's pin's eyelet. */
export function toNetlist(board: BoardState): Netlist {
  const eyelets = computeEyelets(board);
  const pinEyelet = new Map<string, string>();
  for (const e of eyelets) for (const p of e.pins) pinEyelet.set(pinKey(p), e.id);

  const components: ComponentSpec[] = board.components.map((c) => {
    const art = COMPONENT_ART[c.kind];
    const count = art ? art(c.params).pins.length : 0;
    const pins: string[] = [];
    for (let i = 0; i < count; i++) pins.push(pinEyelet.get(`${c.id}:${i}`) ?? `float-${c.id}-${i}`);
    return { id: c.id, kind: c.kind, pins, params: { ...c.params } };
  });

  const eyeletOfNamedPin = (comp: BoardComponent | undefined, name: string): string | undefined => {
    if (!comp) return undefined;
    const pin = pinsOf(comp).find((p) => p.name === name);
    return pin ? pinEyelet.get(pinKey(pin)) : undefined;
  };
  const src = board.components.find((c) => c.kind === 'source');
  const prb = board.components.find((c) => c.kind === 'probe');

  return {
    components,
    sampleRate: board.sampleRate,
    groundEyelet: eyeletOfNamedPin(src, 'gnd'),
    probeEyelet: eyeletOfNamedPin(prb, 'tip'),
  };
}

/** A board can make sound once it has both a source and a probe (the engine handles the rest, and
 *  fails legibly if the wiring is incomplete). */
export function isPlayable(board: BoardState): boolean {
  return board.components.some((c) => c.kind === 'source') && board.components.some((c) => c.kind === 'probe');
}

/**
 * Magnetic snap-on-drop: nudge the just-dropped component so its closest in-range pin lands EXACTLY on
 * the nearest other component's pin. Turns "roughly drag a leg near another" into a clean, unambiguous
 * solder junction (the rest of the part follows rigidly). Returns the board unchanged if nothing is in
 * range. The dragged component aligns to the STATIONARY ones, never the reverse.
 */
export function applyDropSnap(board: BoardState, id: string): BoardState {
  const dragged = board.components.find((c) => c.id === id);
  if (!dragged) return board;
  const dpins = pinsOf(dragged);
  if (dpins.length === 0) return board;
  const others = board.components.filter((c) => c.id !== id).flatMap(pinsOf);
  let bestDx = 0;
  let bestDy = 0;
  let bestD2 = SNAP_MM * SNAP_MM;
  let found = false;
  for (const dp of dpins) {
    for (const op of others) {
      const dx = op.x - dp.x;
      const dy = op.y - dp.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        bestDx = dx;
        bestDy = dy;
        found = true;
      }
    }
  }
  return found ? moveComponent(board, id, dragged.x + bestDx, dragged.y + bestDy) : board;
}

/** A stable fingerprint of the eyelet clustering (which pins share which node). Two boards with the
 *  same signature have the same electrical topology — used to decide whether a value edit that nudged
 *  a pin (e.g. diode Si↔LED changes the body width) actually re-wired anything and needs a relatch. */
export function clusterSignature(board: BoardState): string {
  return computeEyelets(board)
    .map((e) => e.pins.map(pinKey).sort().join(','))
    .sort()
    .join('|');
}
