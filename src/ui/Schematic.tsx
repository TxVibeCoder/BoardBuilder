/**
 * Schematic view — the SAME circuit the eyelet board holds, drawn as a clean SCHEMATIC instead of
 * realistic component art. It is a pure function of the {@link BoardState} (work order: "renderer a
 * pure function of the netlist/board"), needs no audio, and stays in lock-step with the live board.
 *
 * Tractability trick: reuse each component's BOARD GEOMETRY (its body position + rotation, and its
 * real lead-anchor pins via `pinsOf`) but, instead of the value-driven photoreal art, stamp a standard
 * SCHEMATIC SYMBOL per kind (resistor zigzag, capacitor plates, inductor coils, diode triangle+bar,
 * op-amp triangle, BJT circle+arrows, source circle, probe arrow, a ground symbol on the source gnd
 * net). NET CONNECTIONS are straight orthogonal-ish polylines between pins that share an eyelet (from
 * `computeEyelets`) plus the jumper links — so what is one node on the board is one wire here.
 *
 * Everything is mm, in the board's own coordinate space (viewBox 0 0 BOARD_W_MM BOARD_H_MM), so a
 * symbol drawn at a component's two pin anchors lands exactly where its eyelets are. Symbol drawing is
 * kept in small per-kind helpers; values are labelled through `engine/units.ts` (formatOhms etc.).
 */

import { useMemo } from 'react';
import {
  BOARD_H_MM,
  BOARD_W_MM,
  computeEyelets,
  pinsOf,
  resolvePinRef,
  type BoardComponent,
  type BoardPin,
  type BoardState,
} from './board/boardModel';
import { formatOhms } from '../engine/units';

// Schematic palette (ink-on-paper): a light board, dark strokes, blue source, red probe — matching the
// teaching cues the realistic art already uses (blue sine source, red probe ring).
const PAPER = '#f6f1e3';
const INK = '#1c2530';
const WIRE = '#1c2530';
const LABEL = '#3a4654';
const SRC_BLUE = '#2156c4';
const PRB_RED = '#c0392b';
const STROKE = 0.35; // mm — symbol line weight
const WIRE_W = 0.3; // mm — net wire weight
const FONT = 2.0; // mm — value/ref label size

/** Compact, deterministic mm coordinate (mirror the art modules' `num`/`f` rounding). */
function f(n: number): string {
  return Number.isFinite(n) ? (Math.round(n * 1000) / 1000).toString() : '0';
}

/** A component's pins keyed by netlist pin name (resistor a/b, opamp plus/minus/out, …). */
function pinMap(comp: BoardComponent): Map<string, BoardPin> {
  const m = new Map<string, BoardPin>();
  for (const p of pinsOf(comp)) m.set(p.name, p);
  return m;
}

/** Unit vector + normal from pin a→b, plus the midpoint and length (the symbol's local frame). */
function frame(a: BoardPin, b: BoardPin) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len; // along-axis unit
  const nx = -uy;
  const ny = ux; // normal unit
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return { ux, uy, nx, ny, mx, my, len };
}

/** Point at axis offset `along` (from a) and normal offset `off` in a two-pin symbol's local frame. */
function at(a: BoardPin, fr: ReturnType<typeof frame>, along: number, off: number) {
  return { x: a.x + fr.ux * along + fr.nx * off, y: a.y + fr.uy * along + fr.ny * off };
}

function line(x1: number, y1: number, x2: number, y2: number, stroke = INK, w = STROKE): string {
  return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${f(w)}" stroke-linecap="round"/>`;
}

function poly(pts: { x: number; y: number }[], stroke = INK, w = STROKE, fill = 'none'): string {
  const d = pts.map((p) => `${f(p.x)},${f(p.y)}`).join(' ');
  return `<polyline points="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** A small value/reference label, anchored near the symbol body and offset off-axis to stay clear. */
function label(text: string, x: number, y: number, fill = LABEL): string {
  return `<text x="${f(x)}" y="${f(y)}" font-size="${f(FONT)}" fill="${fill}" text-anchor="middle" font-family="sans-serif">${escapeXml(text)}</text>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}

// ── per-kind symbol helpers (each returns an SVG string drawn at the component's real pin anchors) ──

/** Resistor: a zigzag between the two leads (with short lead stubs). */
function resistorSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const a = m.get('a');
  const b = m.get('b');
  if (!a || !b) return '';
  const fr = frame(a, b);
  const body = Math.min(7, fr.len * 0.6);
  const lead = (fr.len - body) / 2;
  const zigs = 6;
  const amp = 1.1;
  const pts = [at(a, fr, lead, 0)];
  for (let i = 0; i < zigs; i++) {
    const along = lead + (body * (i + 0.5)) / zigs;
    pts.push(at(a, fr, along, i % 2 === 0 ? amp : -amp));
  }
  pts.push(at(a, fr, lead + body, 0));
  const r = formatOhms(comp.params.R ?? 0);
  return (
    line(a.x, a.y, pts[0]!.x, pts[0]!.y) +
    poly(pts) +
    line(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, b.x, b.y) +
    label(`${comp.id} ${r}`, fr.mx + fr.nx * (amp + 2.4), fr.my + fr.ny * (amp + 2.4))
  );
}

/** Capacitor: two parallel plates across the axis (curved plate hint omitted — keep it generic). */
function capacitorSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const a = m.get('a');
  const b = m.get('b');
  if (!a || !b) return '';
  const fr = frame(a, b);
  const gap = 0.9; // plate separation along axis
  const plate = 2.2; // half plate height across axis
  const c1 = at(a, fr, (fr.len - gap) / 2, 0);
  const c2 = at(a, fr, (fr.len + gap) / 2, 0);
  const p1a = { x: c1.x + fr.nx * plate, y: c1.y + fr.ny * plate };
  const p1b = { x: c1.x - fr.nx * plate, y: c1.y - fr.ny * plate };
  const p2a = { x: c2.x + fr.nx * plate, y: c2.y + fr.ny * plate };
  const p2b = { x: c2.x - fr.nx * plate, y: c2.y - fr.ny * plate };
  const val = formatFarads(comp.params.C ?? 0);
  return (
    line(a.x, a.y, c1.x, c1.y) +
    line(p1a.x, p1a.y, p1b.x, p1b.y) +
    line(p2a.x, p2a.y, p2b.x, p2b.y) +
    line(c2.x, c2.y, b.x, b.y) +
    label(`${comp.id} ${val}`, fr.mx + fr.nx * (plate + 2.2), fr.my + fr.ny * (plate + 2.2))
  );
}

/** Inductor: a run of small loops (semicircles) between the leads. */
function inductorSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const a = m.get('a');
  const b = m.get('b');
  if (!a || !b) return '';
  const fr = frame(a, b);
  const loops = 4;
  const body = Math.min(7, fr.len * 0.6);
  const lead = (fr.len - body) / 2;
  const r = body / (loops * 2);
  let arcs = '';
  for (let i = 0; i < loops; i++) {
    const s = at(a, fr, lead + i * 2 * r, 0);
    const e = at(a, fr, lead + (i + 1) * 2 * r, 0);
    // sweep the half-loop to the +normal side (concave "humps")
    arcs += `<path d="M${f(s.x)} ${f(s.y)} A ${f(r)} ${f(r)} 0 0 1 ${f(e.x)} ${f(e.y)}" fill="none" stroke="${INK}" stroke-width="${f(STROKE)}"/>`;
  }
  const start = at(a, fr, lead, 0);
  const end = at(a, fr, lead + body, 0);
  const val = formatHenries(comp.params.L ?? 0);
  return (
    line(a.x, a.y, start.x, start.y) +
    arcs +
    line(end.x, end.y, b.x, b.y) +
    label(`${comp.id} ${val}`, fr.mx + fr.nx * (r + 2.4), fr.my + fr.ny * (r + 2.4))
  );
}

/** Diode: a filled triangle (anode→cathode direction) capped by the cathode bar. */
function diodeSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const a = m.get('a'); // anode
  const k = m.get('k'); // cathode
  if (!a || !k) return '';
  const fr = frame(a, k);
  const half = Math.min(2.4, fr.len * 0.18);
  const tipAlong = (fr.len + half * 1.7) / 2;
  const baseAlong = (fr.len - half * 1.7) / 2;
  const tip = at(a, fr, tipAlong, 0);
  const b1 = at(a, fr, baseAlong, half);
  const b2 = at(a, fr, baseAlong, -half);
  const barA = at(a, fr, tipAlong, half);
  const barB = at(a, fr, tipAlong, -half);
  const baseMid = at(a, fr, baseAlong, 0);
  const tri = `<polygon points="${f(b1.x)},${f(b1.y)} ${f(b2.x)},${f(b2.y)} ${f(tip.x)},${f(tip.y)}" fill="${INK}" stroke="${INK}" stroke-width="${f(STROKE)}" stroke-linejoin="round"/>`;
  const id = comp.params.diode ?? 'Si';
  const tag = comp.params.symmetric ? `${comp.id} ${id}±` : `${comp.id} ${id}`;
  return (
    line(a.x, a.y, baseMid.x, baseMid.y) + // anode lead to the triangle base
    tri +
    line(barA.x, barA.y, barB.x, barB.y) + // cathode bar
    line(tip.x, tip.y, k.x, k.y) + // cathode lead
    label(tag, fr.mx + fr.nx * (half + 2.2), fr.my + fr.ny * (half + 2.2))
  );
}

/** Op-amp: the classic triangle pointing at the output, with +/− on the input edge. */
function opampSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const plus = m.get('plus');
  const minus = m.get('minus');
  const out = m.get('out');
  if (!plus || !minus || !out) return '';
  // input edge midpoint → output: the triangle axis
  const inMid = { x: (plus.x + minus.x) / 2, y: (plus.y + minus.y) / 2 };
  const dx = out.x - inMid.x;
  const dy = out.y - inMid.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const h = Math.max(3.5, Math.hypot(plus.x - minus.x, plus.y - minus.y) * 0.7); // half input-edge height
  const base = 1.4; // pull the input edge slightly inboard of the lead anchors
  const baseC = { x: inMid.x + ux * base, y: inMid.y + uy * base };
  const v1 = { x: baseC.x + nx * h, y: baseC.y + ny * h };
  const v2 = { x: baseC.x - nx * h, y: baseC.y - ny * h };
  const tip = { x: out.x - ux * base, y: out.y - uy * base };
  const tri = `<polygon points="${f(v1.x)},${f(v1.y)} ${f(v2.x)},${f(v2.y)} ${f(tip.x)},${f(tip.y)}" fill="none" stroke="${INK}" stroke-width="${f(STROKE)}" stroke-linejoin="round"/>`;
  return (
    line(plus.x, plus.y, baseC.x + nx * h * 0.5, baseC.y + ny * h * 0.5) +
    line(minus.x, minus.y, baseC.x - nx * h * 0.5, baseC.y - ny * h * 0.5) +
    line(tip.x, tip.y, out.x, out.y) +
    tri +
    label('+', plus.x + ux * (base + 1.2) + nx * 0.0, plus.y + uy * (base + 1.2) + ny * 0.0, INK) +
    label('−', minus.x + ux * (base + 1.2), minus.y + uy * (base + 1.2), INK) +
    label(comp.id, (v1.x + v2.x) / 2 + ux * 1.5, (v1.y + v2.y) / 2 + uy * 1.5)
  );
}

/** Pot: a resistor (a→b) with a wiper arrow tapping the middle. */
function potSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const a = m.get('a');
  const b = m.get('b');
  const w = m.get('wiper');
  if (!a || !b || !w) return '';
  const fr = frame(a, b);
  const body = Math.min(8, fr.len * 0.7);
  const lead = (fr.len - body) / 2;
  const zigs = 6;
  const amp = 1.0;
  const pts = [at(a, fr, lead, 0)];
  for (let i = 0; i < zigs; i++) {
    const along = lead + (body * (i + 0.5)) / zigs;
    pts.push(at(a, fr, along, i % 2 === 0 ? amp : -amp));
  }
  pts.push(at(a, fr, lead + body, 0));
  const tap = at(a, fr, fr.len / 2, 0); // arrow head touches the resistor middle
  const arrowTail = { x: w.x, y: w.y };
  // arrowhead at the tap
  const adx = tap.x - arrowTail.x;
  const ady = tap.y - arrowTail.y;
  const al = Math.hypot(adx, ady) || 1;
  const aux = adx / al;
  const auy = ady / al;
  const head =
    line(tap.x, tap.y, tap.x - aux * 1.4 - auy * 0.9, tap.y - auy * 1.4 + aux * 0.9) +
    line(tap.x, tap.y, tap.x - aux * 1.4 + auy * 0.9, tap.y - auy * 1.4 - aux * 0.9);
  const r = formatOhms(comp.params.potR ?? 0);
  return (
    line(a.x, a.y, pts[0]!.x, pts[0]!.y) +
    poly(pts) +
    line(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, b.x, b.y) +
    line(arrowTail.x, arrowTail.y, tap.x, tap.y) +
    head +
    label(`${comp.id} ${r}`, fr.mx + fr.nx * (amp + 2.4), fr.my + fr.ny * (amp + 2.4))
  );
}

/** BJT (NPN): the standard circle with base bar, collector lead, and an emitter arrow pointing out. */
function bjtSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const c = m.get('c');
  const bs = m.get('b');
  const e = m.get('e');
  if (!c || !bs || !e) return '';
  const cx = (c.x + bs.x + e.x) / 3;
  const cy = (c.y + bs.y + e.y) / 3;
  const r = 3.0;
  // base bar: a short vertical-ish segment inside the circle, on the base-side
  const bdx = bs.x - cx;
  const bdy = bs.y - cy;
  const bl = Math.hypot(bdx, bdy) || 1;
  const bux = bdx / bl;
  const buy = bdy / bl; // base direction (outward)
  const barC = { x: cx - bux * 0.4, y: cy - buy * 0.4 };
  const barN = { x: -buy, y: bux }; // along the base bar
  const barTop = { x: barC.x + barN.x * 1.8, y: barC.y + barN.y * 1.8 };
  const barBot = { x: barC.x - barN.x * 1.8, y: barC.y - barN.y * 1.8 };
  // collector + emitter junction points on the base bar
  const cj = nearestOnSeg(barTop, barBot, c);
  const ej = nearestOnSeg(barTop, barBot, e);
  // emitter arrowhead (NPN: arrow points AWAY from base, toward the emitter lead)
  const edx = e.x - ej.x;
  const edy = e.y - ej.y;
  const el = Math.hypot(edx, edy) || 1;
  const eux = edx / el;
  const euy = edy / el;
  const ehead = { x: ej.x + eux * 1.6, y: ej.y + euy * 1.6 };
  const arrow =
    line(ehead.x, ehead.y, ehead.x - eux * 1.3 - euy * 0.8, ehead.y - euy * 1.3 + eux * 0.8) +
    line(ehead.x, ehead.y, ehead.x - eux * 1.3 + euy * 0.8, ehead.y - euy * 1.3 - eux * 0.8);
  return (
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${INK}" stroke-width="${f(STROKE)}"/>` +
    line(bs.x, bs.y, barC.x, barC.y) + // base lead to bar
    line(barTop.x, barTop.y, barBot.x, barBot.y) + // base bar
    line(c.x, c.y, cj.x, cj.y) + // collector lead
    line(e.x, e.y, ej.x, ej.y) + // emitter lead
    arrow +
    label(`${comp.id}`, cx + bux * (r + 2.2), cy + buy * (r + 2.2))
  );
}

/** Closest point on segment p1→p2 to point q (keeps collector/emitter leads touching the base bar). */
function nearestOnSeg(p1: { x: number; y: number }, p2: { x: number; y: number }, q: { x: number; y: number }) {
  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const l2 = vx * vx + vy * vy || 1;
  let t = ((q.x - p1.x) * vx + (q.y - p1.y) * vy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: p1.x + vx * t, y: p1.y + vy * t };
}

/** Source: an AC-source circle (sine glyph) with hot/gnd lead stubs; blue, matching the realistic art. */
function sourceSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const hot = m.get('hot');
  const gnd = m.get('gnd');
  if (!hot || !gnd) return '';
  const cx = (hot.x + gnd.x) / 2 - 3.0; // body sits inboard of the two right-edge leads
  const cy = (hot.y + gnd.y) / 2;
  const r = 3.2;
  // sine glyph
  const w = r * 1.3;
  const amp = r * 0.5;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const sine = `<path d="M${f(x0)} ${f(cy)} C ${f(x0 + w * 0.25)} ${f(cy - amp)}, ${f(cx)} ${f(cy - amp)}, ${f(cx)} ${f(cy)} C ${f(cx)} ${f(cy + amp)}, ${f(x1 - w * 0.25)} ${f(cy + amp)}, ${f(x1)} ${f(cy)}" fill="none" stroke="${SRC_BLUE}" stroke-width="${f(STROKE)}" stroke-linecap="round"/>`;
  const wave = comp.params.wave ?? 'guitar';
  const tag = wave === 'dc' ? `${comp.id} ${comp.params.amp ?? 0}V` : `${comp.id} ${wave}`;
  return (
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${SRC_BLUE}" stroke-width="${f(STROKE)}"/>` +
    sine +
    line(cx + r, cy, hot.x, hot.y, SRC_BLUE) + // (approx) lead to hot
    line(cx, cy + r, gnd.x, gnd.y, SRC_BLUE) + // lead to gnd
    label(tag, cx, cy - r - 1.4, SRC_BLUE)
  );
}

/** Probe: a small filled dot + an arrow, marking the scope/output node. Red, matching the art's ring. */
function probeSymbol(comp: BoardComponent): string {
  const m = pinMap(comp);
  const tip = m.get('tip');
  if (!tip) return '';
  const dirx = 0;
  const diry = -1; // arrow points up out of the node
  const tail = { x: tip.x - dirx * 4, y: tip.y - diry * 4 };
  return (
    `<circle cx="${f(tip.x)}" cy="${f(tip.y)}" r="0.7" fill="${PRB_RED}"/>` +
    line(tip.x, tip.y, tail.x, tail.y, PRB_RED) +
    line(tail.x, tail.y, tail.x - 0.9, tail.y + 1.4, PRB_RED) +
    line(tail.x, tail.y, tail.x + 0.9, tail.y + 1.4, PRB_RED) +
    label(comp.id, tail.x, tail.y - 1.0, PRB_RED)
  );
}

/** Ground symbol (the three-bar earth glyph) drawn pointing down from a net point. */
function groundSymbol(x: number, y: number): string {
  const top = line(x, y, x, y + 1.6);
  const bars =
    line(x - 2.0, y + 1.6, x + 2.0, y + 1.6) +
    line(x - 1.3, y + 2.4, x + 1.3, y + 2.4) +
    line(x - 0.6, y + 3.2, x + 0.6, y + 3.2);
  return top + bars;
}

const SYMBOLS: Partial<Record<BoardComponent['kind'], (c: BoardComponent) => string>> = {
  resistor: resistorSymbol,
  capacitor: capacitorSymbol,
  inductor: inductorSymbol,
  diode: diodeSymbol,
  opamp: opampSymbol,
  pot: potSymbol,
  bjt: bjtSymbol,
  source: sourceSymbol,
  probe: probeSymbol,
};

// ── value formatters not in units.ts (kept local; direction+magnitude bar, not E-series snapped) ──

function formatFarads(c: number): string {
  if (!Number.isFinite(c) || c <= 0) return '0 F';
  if (c >= 1e-6) return `${trim(c / 1e-6)} µF`;
  if (c >= 1e-9) return `${trim(c / 1e-9)} nF`;
  return `${trim(c / 1e-12)} pF`;
}

function formatHenries(l: number): string {
  if (!Number.isFinite(l) || l <= 0) return '0 H';
  if (l >= 1) return `${trim(l)} H`;
  if (l >= 1e-3) return `${trim(l / 1e-3)} mH`;
  return `${trim(l / 1e-6)} µH`;
}

function trim(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/**
 * Build the schematic SVG fragment string for a whole board: net wires first (under the symbols), then
 * each component's schematic symbol, then a ground glyph on the source's gnd eyelet. Pure — no DOM.
 */
export function schematicSvg(board: BoardState): string {
  const eyelets = computeEyelets(board);
  const byId = new Map(board.components.map((c) => [c.id, c]));

  // NET WIRES: for each eyelet (shared node), connect its member pins with an orthogonal-ish elbow to
  // the eyelet centroid, so all legs on one node read as one wire. (One pin = nothing to draw.)
  let wires = '';
  for (const e of eyelets) {
    if (e.pins.length < 2) continue;
    for (const p of e.pins) {
      // L-shaped elbow: horizontal then vertical to the centroid (clean, schematic-style routing)
      const elbow = { x: e.x, y: p.y };
      wires +=
        line(p.x, p.y, elbow.x, elbow.y, WIRE, WIRE_W) +
        line(elbow.x, elbow.y, e.x, e.y, WIRE, WIRE_W);
    }
    // a small junction dot at the centroid when 3+ legs meet (a real solder node)
    if (e.pins.length >= 3) wires += `<circle cx="${f(e.x)}" cy="${f(e.y)}" r="0.5" fill="${WIRE}"/>`;
  }

  // JUMPER links explicitly (in case a jumper bridges two pins not co-located into one eyelet).
  for (const c of board.components) {
    if (c.kind !== 'jumper' || !c.link) continue;
    const a = resolvePinRef(board, c.link.a);
    const b = resolvePinRef(board, c.link.b);
    if (!a || !b) continue;
    wires += line(a.x, a.y, b.x, a.y, WIRE, WIRE_W) + line(b.x, a.y, b.x, b.y, WIRE, WIRE_W);
  }

  // SYMBOLS per non-structural component.
  let symbols = '';
  for (const c of board.components) {
    const draw = SYMBOLS[c.kind];
    if (draw) symbols += draw(c);
  }

  // GROUND glyph on the source's gnd net (find the eyelet that holds the source's 'gnd' pin).
  let ground = '';
  const src = board.components.find((c) => c.kind === 'source');
  if (src) {
    const gndPin = pinsOf(src).find((p) => p.name === 'gnd');
    if (gndPin) {
      const gndEye = eyelets.find((e) => e.pins.some((p) => p.componentId === src.id && p.name === 'gnd'));
      const at0 = gndEye ?? { x: gndPin.x, y: gndPin.y };
      ground = groundSymbol(at0.x, at0.y);
    }
  }
  void byId;

  return wires + symbols + ground;
}

/**
 * The Schematic view component. Renders the board as a clean schematic in the board's own mm space,
 * synced live to the same {@link BoardState} the eyelet board uses (re-derived on every change).
 */
export function Schematic({ board }: { board: BoardState }): JSX.Element {
  const inner = useMemo(() => schematicSvg(board), [board]);
  return (
    <svg
      className="schematic"
      viewBox={`0 0 ${BOARD_W_MM} ${BOARD_H_MM}`}
      style={{ aspectRatio: `${BOARD_W_MM} / ${BOARD_H_MM}`, width: '100%' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x={0} y={0} width={BOARD_W_MM} height={BOARD_H_MM} fill={PAPER} rx={2} />
      <g dangerouslySetInnerHTML={{ __html: inner }} />
    </svg>
  );
}

export default Schematic;
