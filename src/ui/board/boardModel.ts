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

/** Board dimensions in mm (the SVG viewBox). Shared with the renderer so auto-layout and drawing agree. */
export const BOARD_W_MM = 160;
export const BOARD_H_MM = 92;

/** A reference to one pin of a placed component (its leg). Jumpers bridge two of these. */
export interface PinRef {
  componentId: string;
  pinIndex: number;
}

export interface BoardComponent {
  id: string;
  kind: ComponentKind;
  params: ComponentParams;
  x: number; // body origin (mm)
  y: number;
  rot?: number; // orientation in degrees (0/90/180/270), default 0 — rotates about the art centre
  /** Jumper only: the two pins this wire bridges (it has no body/art — it's a pure logical edge). */
  link?: { a: PinRef; b: PinRef };
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
  bjt: 'Q',
  source: 'SRC',
  probe: 'PRB',
  jumper: 'W',
};

const DEFAULTS: Partial<Record<ComponentKind, ComponentParams>> = {
  resistor: { R: 10000 },
  capacitor: { C: 1e-7 },
  inductor: { L: 1e-3 },
  diode: { diode: 'Si', symmetric: true },
  opamp: { vsat: 9 },
  pot: { alpha: 0.5, potR: 10000 },
  bjt: { bjt: 'NPN' },
  source: { wave: 'guitar', amp: 1, rsrc: 1e-6 },
  probe: {},
  jumper: {},
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
  // also drop any jumper that bridged the removed part (its endpoints would dangle otherwise)
  return {
    ...board,
    components: board.components.filter((c) => c.id !== id && c.link?.a.componentId !== id && c.link?.b.componentId !== id),
  };
}

/** Rotate a component by +90° (lead anchors transform with the body; jumpers ignore rotation). */
export function rotateComponent(board: BoardState, id: string): BoardState {
  return {
    ...board,
    components: board.components.map((c) => (c.id === id && c.kind !== 'jumper' ? { ...c, rot: (((c.rot ?? 0) + 90) % 360) } : c)),
  };
}

/** Add a jumper wire bridging two pins (a logical edge — `compileNetlist` unions their eyelets). */
export function addJumper(board: BoardState, a: PinRef, b: PinRef): BoardState {
  if (a.componentId === b.componentId && a.pinIndex === b.pinIndex) return board; // a pin to itself: no-op
  const id = `${PREFIX.jumper ?? 'W'}${board.nextId}`;
  const comp: BoardComponent = { id, kind: 'jumper', params: {}, x: 0, y: 0, link: { a, b } };
  return { ...board, components: [...board.components, comp], nextId: board.nextId + 1 };
}

/** Two AABBs overlap (with a margin)? */
function aabbOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, m: number): boolean {
  return a.x - m < b.x + b.w && a.x + a.w + m > b.x && a.y - m < b.y + b.h && a.y + a.h + m > b.y;
}

/**
 * Find a body origin for a new `kind` whose body won't overlap any existing part — scans a coarse grid
 * across the board and returns the first clear cell (falls back to the top-left if the board is packed),
 * so adding e.g. a diode never lands on top of another component.
 */
export function findFreeSlot(board: BoardState, kind: ComponentKind): { x: number; y: number } {
  const art = COMPONENT_ART[kind]?.(defaultParams(kind));
  const w = art?.width ?? 8;
  const h = art?.height ?? 8;
  const margin = 2;
  const step = 4;
  const occupied = board.components.map(componentAABB).filter((b): b is { x: number; y: number; w: number; h: number } => b !== null);
  for (let y = 4; y + h <= BOARD_H_MM - 2; y += step) {
    for (let x = 4; x + w <= BOARD_W_MM - 2; x += step) {
      const box = { x, y, w, h };
      if (!occupied.some((o) => aabbOverlap(box, o, margin))) return { x, y };
    }
  }
  return { x: 6, y: 6 };
}

export function updateParams(board: BoardState, id: string, params: Partial<ComponentParams>): BoardState {
  return {
    ...board,
    components: board.components.map((c) => (c.id === id ? { ...c, params: { ...c.params, ...params } } : c)),
  };
}

/** Rotate a local art point (lx,ly) about the art centre by a component's orientation (degrees). */
function rotateLocal(lx: number, ly: number, w: number, h: number, rotDeg: number): { x: number; y: number } {
  const rot = rotDeg || 0;
  if (rot === 0) return { x: lx, y: ly };
  const cx = w / 2;
  const cy = h / 2;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = lx - cx;
  const dy = ly - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** Absolute pin positions for one component (empty if the kind has no art — e.g. a jumper). */
export function pinsOf(comp: BoardComponent): BoardPin[] {
  const art = COMPONENT_ART[comp.kind];
  if (!art) return [];
  const a = art(comp.params);
  return a.pins.map((p, i) => {
    const r = rotateLocal(p.x, p.y, a.width, a.height, comp.rot ?? 0);
    return { componentId: comp.id, pinIndex: i, name: p.name, x: comp.x + r.x, y: comp.y + r.y };
  });
}

/** The absolute axis-aligned bounding box of a placed component's body (mm), accounting for rotation. */
export function componentAABB(comp: BoardComponent): { x: number; y: number; w: number; h: number } | null {
  const art = COMPONENT_ART[comp.kind];
  if (!art) return null;
  const a = art(comp.params);
  const rot = ((comp.rot ?? 0) % 360) + (comp.rot && comp.rot < 0 ? 360 : 0);
  const rad = (rot * Math.PI) / 180;
  const ew = Math.abs(a.width * Math.cos(rad)) + Math.abs(a.height * Math.sin(rad));
  const eh = Math.abs(a.width * Math.sin(rad)) + Math.abs(a.height * Math.cos(rad));
  // rotation is about the art centre, so the AABB shares that centre
  const ccx = comp.x + a.width / 2;
  const ccy = comp.y + a.height / 2;
  return { x: ccx - ew / 2, y: ccy - eh / 2, w: ew, h: eh };
}

/** Resolve a pin reference to its current absolute position (null if the component/pin is gone). */
export function resolvePinRef(board: BoardState, ref: PinRef): BoardPin | null {
  const comp = board.components.find((c) => c.id === ref.componentId);
  if (!comp) return null;
  return pinsOf(comp).find((p) => p.pinIndex === ref.pinIndex) ?? null;
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
    if (c.kind === 'jumper') {
      // a jumper is a logical edge: its two pins are the eyelets of the legs it bridges
      const a = c.link ? pinEyelet.get(`${c.link.a.componentId}:${c.link.a.pinIndex}`) : undefined;
      const b = c.link ? pinEyelet.get(`${c.link.b.componentId}:${c.link.b.pinIndex}`) : undefined;
      return { id: c.id, kind: 'jumper', pins: [a ?? `float-${c.id}-0`, b ?? `float-${c.id}-1`], params: {} };
    }
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
