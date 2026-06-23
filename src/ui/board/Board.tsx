/**
 * The interactive EYELET BOARD (work order §3, §7). Drop components from the palette; each lands with
 * brass eyelets at its leg tips. Drag a component so a leg meets another leg — within the snap radius
 * they merge into one gold soldered eyelet (one electrical node); drag away and they split. The engine
 * netlist is derived from the board geometry (a pure function), loaded LIVE into the AudioWorklet, so
 * pressing Play and turning a value is heard and seen on the scope at once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import circuitWorkletUrl from '../../engine/worklets/circuit.worklet.ts?worker&url';
import type { ComponentArt } from './artTypes';
import { artFor } from './componentArt';
import {
  addComponent,
  addJumper,
  applyDropSnap,
  BOARD_H_MM,
  BOARD_W_MM,
  clusterSignature,
  computeEyelets,
  emptyBoard,
  findFreeSlot,
  isPlayable,
  moveComponent,
  pinsOf,
  removeComponent,
  resolvePinRef,
  rotateComponent,
  SNAP_MM,
  toNetlist,
  updateParams,
  type BoardComponent,
  type BoardPin,
  type BoardState,
  type PinRef,
} from './boardModel';
import { PREMADE_CIRCUITS } from './premadeBoards';
import { BiasOverlay } from './BiasOverlay';
import { downloadBoard, listSlots, loadBoardFromFile, loadSlot, saveSlot } from './boardStorage';
import { FreqResponse } from '../FreqResponse';
import { Schematic } from '../Schematic';
import type { ComponentKind, ComponentParams } from '../../engine/dsp/netlist';
import type { DiodeId } from '../../engine/dsp/constants';
import { FLAG_FLOATING, FLAG_NO_RETURN_PATH, FLAG_NONFINITE, FLAG_OPAMP_NO_FEEDBACK } from '../../engine/dsp/mnaSystem';
import { clamp, formatOhms } from '../../engine/units';

const BOARD_W = BOARD_W_MM; // mm
const BOARD_H = BOARD_H_MM;
const ASPECT = BOARD_H / BOARD_W; // viewBox must keep the board's aspect (the <svg> aspect is fixed)
const MIN_VB_W = BOARD_W * 0.18; // tightest zoom ≈ 5.5× (smaller viewBox ⇒ bigger parts)
const SRC_HZ = 110;
const SCOPE_W = 1600;
const SCOPE_H = 320;

const PALETTE: { kind: ComponentKind; label: string }[] = [
  { kind: 'source', label: 'Source' },
  { kind: 'resistor', label: 'Resistor' },
  { kind: 'capacitor', label: 'Capacitor' },
  { kind: 'diode', label: 'Diode' },
  { kind: 'bjt', label: 'Transistor' },
  { kind: 'pot', label: 'Pot' },
  { kind: 'opamp', label: 'Op-Amp' },
  { kind: 'probe', label: 'Probe' },
];

/** Friendly leg names per kind — shown upright on the SELECTED part so you can tell hot from ground,
 *  anode from cathode, or C/B/E (even on a rotated part, where the baked art labels read sideways). */
const PIN_LABELS: Partial<Record<ComponentKind, Record<string, string>>> = {
  source: { hot: 'hot', gnd: 'gnd' },
  resistor: { a: 'a', b: 'b' },
  capacitor: { a: 'a', b: 'b' },
  inductor: { a: 'a', b: 'b' },
  diode: { a: 'anode', k: 'cathode' },
  opamp: { plus: '+in', minus: '−in', out: 'out' },
  pot: { a: 'a', wiper: 'wiper', b: 'b' },
  bjt: { c: 'C', b: 'B', e: 'E' },
  probe: { tip: 'tip' },
};
const pinLabel = (kind: ComponentKind, name: string): string => PIN_LABELS[kind]?.[name] ?? name;

/** Premade circuits grouped by their menu group (pedals vs synth) for the Load dropdown's optgroups. */
const PREMADE_GROUPS: [string, { id: string; name: string }[]][] = (() => {
  const g: Record<string, { id: string; name: string }[]> = {};
  for (const c of PREMADE_CIRCUITS) (g[c.group ?? 'Pedals & EQ'] ??= []).push({ id: c.id, name: c.name });
  return Object.entries(g);
})();

/** Insulated-wire colours for jumpers, cycled by index so adjacent wires read distinctly. */
const WIRE_COLORS = ['#d2402f', '#2f7dd2', '#39a85a', '#d99a2b', '#9a52c9', '#23a7b5'];

/** A gently-sagging wire path between two board points (mm). */
function wirePath(ax: number, ay: number, bx: number, by: number): string {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const sag = Math.min(7, len * 0.14);
  const nx = -dy / len;
  const ny = dx / len;
  const mx = (ax + bx) / 2 + nx * sag;
  const my = (ay + by) / 2 + ny * sag;
  return `M${ax} ${ay} Q ${mx} ${my} ${bx} ${by}`;
}

const FLAG_BADGES: { bit: number; text: string }[] = [
  { bit: FLAG_FLOATING, text: 'floating node — a leg has no connection' },
  { bit: FLAG_OPAMP_NO_FEEDBACK, text: 'op-amp has no feedback path' },
  { bit: FLAG_NONFINITE, text: 'circuit unsolvable as wired' },
  { bit: FLAG_NO_RETURN_PATH, text: 'no current path — the probe just reads the source. Add a resistor from here to ground (a divider) so this part changes the signal' },
];

function makeLimiterCurve(samples = 1024): Float32Array {
  const c = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 1.5) / Math.tanh(1.5);
  }
  return c;
}

function artUri(art: ComponentArt): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.width} ${art.height}">${art.svg}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Log-mapped slider row (for R/C/Ω spanning decades). */
function LogRow(props: { label: string; value: number; min: number; max: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  const { label, value, min, max, fmt, onChange } = props;
  const t = Math.log(value / min) / Math.log(max / min);
  return (
    <div className="ctl">
      <label>
        {label} <span className="val">{fmt(value)}</span>
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0}
        onChange={(e) => onChange(min * Math.pow(max / min, Number(e.target.value)))}
      />
    </div>
  );
}

export function Board() {
  const [board, setBoard] = useState<BoardState>(() => emptyBoard());
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [flags, setFlags] = useState(0);
  // jumper-wire drawing: the leg the pending wire started from, and the live cursor for the rubber-band
  const [wireStart, setWireStart] = useState<PinRef | null>(null);
  const [wireCursor, setWireCursor] = useState<{ x: number; y: number } | null>(null);
  // main-view switch (build canvas / schematic / frequency response) + DC-bias overlay toggle
  const [view, setView] = useState<'board' | 'schematic' | 'response'>('board');
  const [showBias, setShowBias] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // pan/zoom: the board's SVG viewBox in mm. Smaller w/h ⇒ zoomed in; x/y pan within the board.
  const [vb, setVb] = useState({ x: 0, y: 0, w: BOARD_W, h: BOARD_H });

  const boardRef = useRef(board);
  boardRef.current = board;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const startingRef = useRef(false); // re-entrancy guard for the async start()
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const inAnalyserRef = useRef<AnalyserNode | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const eyelets = useMemo(() => computeEyelets(board), [board]);
  // derived netlist for the analysis views (recomputed only when the board changes)
  const analysisNet = useMemo(() => toNetlist(board), [board]);

  /** Push the current board to the worklet — authoritative in BOTH directions: load the derived netlist
   *  when playable, otherwise unload so a now-incomplete board (e.g. its source/probe was deleted) goes
   *  silent and its teaching badges clear, instead of phantom-playing the last circuit. */
  const relatch = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    const b = boardRef.current;
    if (isPlayable(b)) {
      node.port.postMessage({ type: 'load', netlist: toNetlist(b) });
    } else {
      node.port.postMessage({ type: 'unload' });
      setFlags(0);
    }
  }, []);

  // screen → board mm, through the CURRENT viewBox (so drag/wire stay accurate when zoomed/panned)
  const clientToBoard = (e: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const v = vbRef.current;
    return { x: v.x + ((e.clientX - rect.left) / rect.width) * v.w, y: v.y + ((e.clientY - rect.top) / rect.height) * v.h };
  };

  // ---- pan / zoom -------------------------------------------------------------------------------
  const clampVb = (x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } => ({
    x: clamp(x, 0, Math.max(0, BOARD_W - w)),
    y: clamp(y, 0, Math.max(0, BOARD_H - h)),
    w,
    h,
  });
  /** Zoom by `factor` (<1 = in) keeping the board point (cx,cy) fixed under the cursor. */
  const zoomBy = (factor: number, cx: number, cy: number): void =>
    setVb((v) => {
      const w = clamp(v.w * factor, MIN_VB_W, BOARD_W);
      const h = w * ASPECT;
      return clampVb(cx - ((cx - v.x) / v.w) * w, cy - ((cy - v.y) / v.h) * h, w, h);
    });
  const zoomCenter = (factor: number): void => {
    const v = vbRef.current;
    zoomBy(factor, v.x + v.w / 2, v.y + v.h / 2);
  };
  const resetZoom = (): void => setVb({ x: 0, y: 0, w: BOARD_W, h: BOARD_H });

  const startDrag = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const c = boardRef.current.components.find((k) => k.id === id);
    if (!c) return;
    const p = clientToBoard(e);
    dragRef.current = { id, dx: p.x - c.x, dy: p.y - c.y, moved: false };
    setSelected(id);
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  // Begin a pan when pressing empty board (a click there still deselects / cancels a pending wire).
  const onBackgroundDown = (e: React.PointerEvent) => {
    if (wireStart) {
      setWireStart(null);
      setWireCursor(null);
      setSelected(null);
      return;
    }
    const v = vbRef.current;
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const pan = panRef.current;
    if (pan) {
      const svg = svgRef.current;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const v = vbRef.current;
        if (Math.abs(e.clientX - pan.sx) + Math.abs(e.clientY - pan.sy) > 3) pan.moved = true;
        const dx = ((e.clientX - pan.sx) / rect.width) * v.w;
        const dy = ((e.clientY - pan.sy) / rect.height) * v.h;
        setVb(clampVb(pan.ox - dx, pan.oy - dy, v.w, v.h));
      }
      return;
    }
    if (wireStart) setWireCursor(clientToBoard(e)); // rubber-band the pending wire toward the cursor
    const d = dragRef.current;
    if (!d) return;
    const p = clientToBoard(e);
    d.moved = true;
    setBoard((b) => moveComponent(b, d.id, p.x - d.dx, p.y - d.dy));
  };

  // Ends a drag from pointerup OR a cancelled/lost-capture gesture (touch interruption, mid-drag
  // unmount) so the part never sticks to the cursor and a moved-then-cancelled drag still relatches.
  const endDrag = (e: React.PointerEvent) => {
    const pan = panRef.current;
    if (pan) {
      panRef.current = null;
      try {
        svgRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already released */
      }
      if (!pan.moved) setSelected(null); // a click on empty board (no drag) deselects
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    if (d.moved) {
      const snapped = applyDropSnap(boardRef.current, d.id); // click a near leg onto its target
      boardRef.current = snapped;
      setBoard(snapped);
      relatch(); // re-wire only after the drag settles (the allowed relatch gap)
    }
  };

  const commit = (next: BoardState, sel?: string | null): void => {
    boardRef.current = next;
    setBoard(next);
    if (sel !== undefined) setSelected(sel);
    relatch();
  };

  const addPart = (kind: ComponentKind) => {
    const b = boardRef.current;
    const slot = findFreeSlot(b, kind); // auto-place in a clear spot so parts never spawn overlapping
    const next = addComponent(b, kind, slot.x, slot.y);
    commit(next, next.components[next.components.length - 1]!.id);
  };

  const deleteSelected = () => {
    if (!selected) return;
    commit(removeComponent(boardRef.current, selected), null);
  };

  const rotateSelected = () => {
    if (!selected) return;
    commit(rotateComponent(boardRef.current, selected)); // pin positions move ⇒ relatch rebuilds topology
  };

  const clearBoard = () => {
    if (boardRef.current.components.length && !window.confirm('Clear the board?')) return;
    setWireStart(null);
    commit(emptyBoard(), null);
  };

  const loadPremade = (id: string) => {
    const c = PREMADE_CIRCUITS.find((p) => p.id === id);
    if (!c) return;
    if (boardRef.current.components.length && !window.confirm(`Load "${c.name}"? This replaces the current board.`)) return;
    setWireStart(null);
    commit(c.build(), null);
  };

  // ---- save / load (BoardState is the single source of truth — see boardStorage) ----------------
  const exportBoard = () => downloadBoard(boardRef.current);
  const importBoard = async (file: File) => {
    try {
      commit(await loadBoardFromFile(file), null);
    } catch (err) {
      window.alert(`Import failed: ${(err as Error).message}`);
    }
  };
  const saveBoard = () => {
    const name = window.prompt('Save board as:');
    if (name) saveSlot(name, boardRef.current);
  };
  const loadSaved = () => {
    const names = listSlots();
    if (!names.length) {
      window.alert('No saved boards yet — use Save first.');
      return;
    }
    const name = window.prompt(`Load which board?\n${names.join(', ')}`, names[0]);
    if (!name) return;
    const b = loadSlot(name);
    if (b) commit(b, null);
    else window.alert(`No saved board "${name}".`);
  };

  // Click a leg/eyelet to start a wire; click another to finish it (a jumper between the two nodes).
  const onEyeletDown = (e: React.PointerEvent, pins: BoardPin[]) => {
    e.stopPropagation();
    const rep = pins[0];
    if (!rep) return;
    const ref: PinRef = { componentId: rep.componentId, pinIndex: rep.pinIndex };
    if (!wireStart) {
      setWireStart(ref);
      setWireCursor({ x: rep.x, y: rep.y });
      setSelected(null);
    } else {
      const next = addJumper(boardRef.current, wireStart, ref);
      setWireStart(null);
      setWireCursor(null);
      if (next !== boardRef.current) commit(next, null);
    }
  };

  const onParam = (id: string, params: Partial<ComponentParams>) => {
    const before = boardRef.current;
    const after = updateParams(before, id, params);
    setBoard(after);
    boardRef.current = after;
    if (!nodeRef.current) return;
    // A value can nudge a pin (e.g. diode Si↔LED changes the body width) and so make/break a snap-merge.
    // If the wiring actually changed, relatch (rebuild topology); otherwise it's a glitch-free value tweak.
    if (clusterSignature(before) !== clusterSignature(after)) relatch();
    else nodeRef.current.port.postMessage({ type: 'set', id, params });
  };

  // ---- scope -----------------------------------------------------------------------------------
  const draw = useCallback(() => {
    const inAn = inAnalyserRef.current;
    const outAn = outAnalyserRef.current;
    const g = canvasRef.current?.getContext('2d');
    if (!inAn || !outAn || !g) return;
    const size = outAn.fftSize;
    const inBuf = new Float32Array(size);
    const outBuf = new Float32Array(size);
    inAn.getFloatTimeDomainData(inBuf);
    outAn.getFloatTimeDomainData(outBuf);
    let start = 0;
    for (let i = 1; i < size - 1; i++) {
      if (outBuf[i - 1]! < 0 && outBuf[i]! >= 0) {
        start = i;
        break;
      }
    }
    const span = Math.max(2, Math.min(Math.floor((3 * 48000) / SRC_HZ), size - start - 1)); // ≥2 ⇒ no /0
    let peak = 0.05;
    for (let i = 0; i < size; i++) {
      const a = Math.abs(outBuf[i]!);
      const b = Math.abs(inBuf[i]!);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    const vs = ((SCOPE_H / 2) * 0.9) / (peak * 1.15);
    const mid = SCOPE_H / 2;
    g.clearRect(0, 0, SCOPE_W, SCOPE_H);
    g.strokeStyle = '#3a2c1c';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(SCOPE_W, mid);
    g.stroke();
    const plot = (buf: Float32Array, color: string, w: number) => {
      g.strokeStyle = color;
      g.lineWidth = w;
      g.beginPath();
      for (let i = 0; i < span; i++) {
        const x = (i / (span - 1)) * SCOPE_W;
        const y = mid - (buf[start + i] ?? 0) * vs;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    };
    plot(inBuf, '#6b5536', 3);
    plot(outBuf, '#ffcf6b', 4);
    rafRef.current = requestAnimationFrame(draw);
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    ctxRef.current?.close();
    ctxRef.current = null;
    nodeRef.current = null;
    inAnalyserRef.current = null;
    outAnalyserRef.current = null;
    setPlaying(false);
    setFlags(0); // audio stopped → no live badges
  }, []);

  const start = useCallback(async () => {
    if (ctxRef.current || startingRef.current) return; // ignore extra Play clicks during the async setup
    startingRef.current = true;
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(circuitWorkletUrl);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = SRC_HZ;
      const inGain = ctx.createGain();
      inGain.gain.value = 1;
      const node = new AudioWorkletNode(ctx, 'boardbuilder-circuit', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent) => {
        const m = e.data as { type?: string; flags?: number };
        if (m.type === 'flags' && typeof m.flags === 'number') setFlags(m.flags);
      };
      const inAnalyser = ctx.createAnalyser();
      inAnalyser.fftSize = 4096;
      const outAnalyser = ctx.createAnalyser();
      outAnalyser.fftSize = 4096;
      const makeup = ctx.createGain();
      makeup.gain.value = 0.35;
      const limiter = ctx.createWaveShaper();
      limiter.curve = makeLimiterCurve() as Float32Array<ArrayBuffer>;
      limiter.oversample = '2x';
      osc.connect(inGain);
      inGain.connect(inAnalyser);
      inGain.connect(node);
      node.connect(outAnalyser);
      node.connect(makeup);
      makeup.connect(limiter).connect(ctx.destination);
      osc.start();
      ctxRef.current = ctx;
      nodeRef.current = node;
      inAnalyserRef.current = inAnalyser;
      outAnalyserRef.current = outAnalyser;
      setPlaying(true);
      if (isPlayable(boardRef.current)) node.port.postMessage({ type: 'load', netlist: toNetlist(boardRef.current) });
      rafRef.current = requestAnimationFrame(draw);
    } finally {
      startingRef.current = false;
    }
  }, [draw]);

  useEffect(() => () => void ctxRef.current?.close(), []);

  // wheel zoom, centred on the cursor. A native non-passive listener so preventDefault() actually stops
  // the page from scrolling; re-attached when the board <svg> remounts (e.g. after a view switch).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || view !== 'board') return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const v = vbRef.current;
      const cx = v.x + ((e.clientX - rect.left) / rect.width) * v.w;
      const cy = v.y + ((e.clientY - rect.top) / rect.height) * v.h;
      zoomBy(e.deltaY < 0 ? 0.85 : 1 / 0.85, cx, cy);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // keyboard: Esc cancels a pending wire / deselects; R rotates and Del/Backspace deletes the selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing = t != null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      if (e.key === 'Escape') {
        setWireStart(null);
        setWireCursor(null);
        setSelected(null);
      } else if (!typing && (e.key === 'r' || e.key === 'R') && selected) {
        e.preventDefault();
        commit(rotateComponent(boardRef.current, selected));
      } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        commit(removeComponent(boardRef.current, selected), null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const sel = board.components.find((c) => c.id === selected) ?? null;
  const activeFlags = FLAG_BADGES.filter((f) => (flags & f.bit) !== 0);
  // A DC source is a supply rail (Vcc), not a second signal source — don't warn about it.
  const dupSource = board.components.filter((c) => c.kind === 'source' && (c.params.wave ?? 'guitar') !== 'dc').length > 1;
  const dupProbe = board.components.filter((c) => c.kind === 'probe').length > 1;
  const jumpers = board.components.filter((c) => c.kind === 'jumper');
  const wireStartPos = wireStart ? resolvePinRef(board, wireStart) : null;

  // while dragging, mark the legs the moving part will snap onto if released now (catch-range feedback)
  const dragId = dragRef.current?.id;
  const snapTargets: { x: number; y: number }[] = [];
  if (dragId) {
    const dragged = board.components.find((c) => c.id === dragId);
    if (dragged) {
      const dp = pinsOf(dragged);
      const r2 = SNAP_MM * SNAP_MM;
      for (const c of board.components) {
        if (c.id === dragId) continue;
        for (const op of pinsOf(c)) {
          if (dp.some((p) => (p.x - op.x) ** 2 + (p.y - op.y) ** 2 <= r2)) snapTargets.push({ x: op.x, y: op.y });
        }
      }
    }
  }

  return (
    <div className="wrap board-wrap">
      <div className="board-bar">
        <select
          className="add"
          value=""
          onChange={(e) => {
            if (e.target.value) loadPremade(e.target.value);
            e.target.value = '';
          }}
          title="Load a ready-made circuit onto the board"
        >
          <option value="">📂 Load a circuit…</option>
          {PREMADE_GROUPS.map(([group, circuits]) => (
            <optgroup key={group} label={group}>
              {circuits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="spacer" />
        {PALETTE.map((p) => (
          <button key={p.kind} className="add" onClick={() => addPart(p.kind)}>
            + {p.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="add" disabled={!selected || sel?.kind === 'jumper'} onClick={rotateSelected} title="Rotate selected (R)">
          ⟳ Rotate
        </button>
        <button className="add" disabled={!selected} onClick={deleteSelected} title="Delete selected (Del)">
          🗑 Delete
        </button>
        <button className="add" onClick={clearBoard} title="Clear the whole board">
          ✦ New
        </button>
        <span className="spacer" />
        <button className={`add ${view === 'board' ? 'on' : ''}`} onClick={() => setView('board')} title="Build canvas">
          Board
        </button>
        <button className={`add ${view === 'schematic' ? 'on' : ''}`} onClick={() => setView('schematic')} title="Schematic of the same circuit">
          Schematic
        </button>
        <button className={`add ${view === 'response' ? 'on' : ''}`} onClick={() => setView('response')} title="Frequency response (Bode magnitude)">
          Response
        </button>
        <button className={`add ${showBias ? 'on' : ''}`} disabled={view !== 'board'} onClick={() => setShowBias((v) => !v)} title="Overlay DC operating-point voltages">
          Bias
        </button>
        <button className="add" disabled={view !== 'board'} onClick={() => zoomCenter(0.8)} title="Zoom in (or scroll the wheel over the board)">
          ＋
        </button>
        <button className="add" disabled={view !== 'board'} onClick={() => zoomCenter(1.25)} title="Zoom out">
          −
        </button>
        <button className="add" disabled={view !== 'board' || (vb.w >= BOARD_W && vb.x === 0 && vb.y === 0)} onClick={resetZoom} title="Fit the whole board">
          Fit
        </button>
        <span className="spacer" />
        <button className="add" onClick={saveBoard} title="Save to a named slot">
          Save
        </button>
        <button className="add" onClick={loadSaved} title="Open a saved board">
          Open
        </button>
        <button className="add" onClick={exportBoard} title="Download as a .json file">
          Export
        </button>
        <button className="add" onClick={() => fileInputRef.current?.click()} title="Import a .json board file">
          Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importBoard(f);
            e.currentTarget.value = '';
          }}
        />
        <button className={`play ${playing ? 'stop' : ''}`} onClick={() => (playing ? stop() : void start())}>
          {playing ? '■ Stop' : '▶ Play'}
        </button>
      </div>

      {view === 'board' && (
      <svg
        ref={svgRef}
        className="board"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        style={{ aspectRatio: `${BOARD_W} / ${BOARD_H}`, touchAction: 'none' }}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onPointerDown={onBackgroundDown}
      >
        <rect x={0} y={0} width={BOARD_W} height={BOARD_H} fill="#c8a86a" rx={2} />
        {/* jumper wires (logical connections), drawn under the parts; click one to select it */}
        {jumpers.map((j, i) => {
          if (!j.link) return null;
          const a = resolvePinRef(board, j.link.a);
          const b = resolvePinRef(board, j.link.b);
          if (!a || !b) return null;
          const d = wirePath(a.x, a.y, b.x, b.y);
          const sel = selected === j.id;
          return (
            <g key={j.id} style={{ cursor: 'pointer' }} onPointerDown={(e) => { e.stopPropagation(); setSelected(j.id); setWireStart(null); }}>
              <path d={d} fill="none" stroke="#160f07" strokeWidth={1.2} strokeOpacity={0.45} strokeLinecap="round" />
              <path d={d} fill="none" stroke={sel ? '#ffffff' : WIRE_COLORS[i % WIRE_COLORS.length]} strokeWidth={sel ? 0.95 : 0.7} strokeLinecap="round" />
            </g>
          );
        })}
        {/* board-level leads: each pin soldered to its eyelet centroid */}
        {eyelets.flatMap((e) =>
          e.pins.map((p) => <line key={`${p.componentId}:${p.pinIndex}-lead`} x1={p.x} y1={p.y} x2={e.x} y2={e.y} stroke="#c9cdd2" strokeWidth={0.4} strokeLinecap="round" />),
        )}
        {/* components (rotated about their art centre so legs and body stay aligned) */}
        {board.components.map((c) => {
          const art = artFor(c.kind)?.(c.params);
          if (!art) return null;
          const rot = c.rot ?? 0;
          const xf = rot ? `rotate(${rot} ${c.x + art.width / 2} ${c.y + art.height / 2})` : undefined;
          return (
            <g key={c.id} transform={xf}>
              <image href={artUri(art)} x={c.x} y={c.y} width={art.width} height={art.height} />
              {selected === c.id && <rect x={c.x - 0.6} y={c.y - 0.6} width={art.width + 1.2} height={art.height + 1.2} fill="none" stroke="#e0552b" strokeWidth={0.4} strokeDasharray="1.2 0.8" rx={0.8} />}
              <rect x={c.x} y={c.y} width={art.width} height={art.height} fill="transparent" style={{ cursor: 'grab' }} onPointerDown={(e) => startDrag(e, c.id)} />
            </g>
          );
        })}
        {/* eyelets on top: gold solder blob (≥2 legs) or open brass ring (1 leg). Click to wire. */}
        {eyelets.map((e) => {
          const merged = e.pins.length >= 2;
          return (
            <g key={e.id} style={{ cursor: 'crosshair' }} onPointerDown={(ev) => onEyeletDown(ev, e.pins)}>
              {wireStart && <circle cx={e.x} cy={e.y} r={1.9} fill="none" stroke="#7fe08a" strokeWidth={0.3} strokeDasharray="0.8 0.6" />}
              <circle cx={e.x} cy={e.y} r={merged ? 1.15 : 1.0} fill={merged ? '#e8b54a' : '#1d150c'} stroke={merged ? '#8a6420' : '#caa15a'} strokeWidth={merged ? 0.25 : 0.45} />
            </g>
          );
        })}
        {/* leg labels for the SELECTED part — upright so they stay readable on a rotated part */}
        {sel &&
          sel.kind !== 'jumper' &&
          pinsOf(sel).map((pin) => {
            const label = pinLabel(sel.kind, pin.name);
            const w = label.length * 0.95 + 1.2;
            const above = pin.y > 7; // flip below if the pin is near the top edge
            const ty = above ? pin.y - 1.9 : pin.y + 3.4;
            return (
              <g key={`pinlbl-${pin.pinIndex}`} pointerEvents="none">
                <rect x={pin.x - w / 2} y={ty - 1.7} width={w} height={2.2} rx={0.4} fill="#15100a" opacity={0.82} />
                <text x={pin.x} y={ty} fontSize={1.5} fill="#ffe2a6" textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          })}
        {/* live "release here to connect" markers while dragging a part */}
        {snapTargets.map((t, i) => (
          <circle key={`snap-${i}`} cx={t.x} cy={t.y} r={1.7} fill="none" stroke="#7fe08a" strokeWidth={0.45} strokeDasharray="1 0.7" />
        ))}
        {/* pending wire: rubber-band from the start leg to the cursor */}
        {wireStartPos && wireCursor && (
          <>
            <line x1={wireStartPos.x} y1={wireStartPos.y} x2={wireCursor.x} y2={wireCursor.y} stroke="#39e06a" strokeWidth={0.6} strokeDasharray="1.4 1" strokeLinecap="round" />
            <circle cx={wireStartPos.x} cy={wireStartPos.y} r={1.5} fill="none" stroke="#39e06a" strokeWidth={0.5} />
          </>
        )}
        {showBias && <BiasOverlay board={board} />}
      </svg>
      )}

      {view === 'schematic' && <Schematic board={board} />}
      {view === 'response' && <FreqResponse netlist={analysisNet} />}

      {view === 'board' && (
      <div className="board-hint">
        {wireStart ? (
          <b>Wire mode: click another eyelet to connect, or press Esc to cancel.</b>
        ) : (
          <>
            Drop parts, drag a leg onto another to fuse them (gold eyelet), or <b>click two eyelets</b> to run a jumper wire between
            distant nodes. <b>R</b> rotates the selected part. Add a <b>Source</b> + <b>Probe</b>, press <b>Play</b>, turn a value —
            or <b>Load a circuit</b> to start from a working one.
          </>
        )}
        {activeFlags.map((f) => (
          <span key={f.bit} className="badge">
            ⚠ {f.text}
          </span>
        ))}
        {dupSource && <span className="badge">⚠ multiple signal sources — only the first sets ground</span>}
        {dupProbe && <span className="badge">⚠ multiple probes — only the first is scoped</span>}
      </div>
      )}

      <canvas ref={canvasRef} className="scope board-scope" width={SCOPE_W} height={SCOPE_H} />

      {sel && (
        <div className="controls">
          <div className="ctl-head">
            {sel.kind} <code>{sel.id}</code>
          </div>
          <Editor comp={sel} onParam={(p) => onParam(sel.id, p)} />
        </div>
      )}
    </div>
  );
}

function Editor({ comp, onParam }: { comp: BoardComponent; onParam: (p: Partial<ComponentParams>) => void }) {
  const p = comp.params;
  switch (comp.kind) {
    case 'resistor':
      return <LogRow label="Resistance" value={p.R ?? 10000} min={100} max={1e6} fmt={formatOhms} onChange={(v) => onParam({ R: v })} />;
    case 'capacitor':
      return <LogRow label="Capacitance" value={p.C ?? 1e-7} min={1e-9} max={1e-4} fmt={(v) => `${(v * 1e9).toFixed(v < 1e-7 ? 1 : 0)} nF`} onChange={(v) => onParam({ C: v })} />;
    case 'pot':
      return (
        <>
          <div className="ctl">
            <label>
              Wiper <span className="val">{((p.alpha ?? 0.5) * 100).toFixed(0)}%</span>
            </label>
            <input type="range" min={0} max={1} step={0.005} value={p.alpha ?? 0.5} onChange={(e) => onParam({ alpha: Number(e.target.value) })} />
          </div>
          <LogRow label="Total R" value={p.potR ?? 10000} min={1000} max={1e6} fmt={formatOhms} onChange={(v) => onParam({ potR: v })} />
        </>
      );
    case 'diode':
      return (
        <div className="ctl">
          <label>Diode</label>
          <div className="seg">
            {(['Si', 'Ge', 'LED'] as DiodeId[]).map((d) => (
              <button key={d} className={(p.diode ?? 'Si') === d ? 'on' : ''} onClick={() => onParam({ diode: d })}>
                {d}
              </button>
            ))}
          </div>
          <label style={{ marginTop: 8 }}>
            <input type="checkbox" checked={p.symmetric ?? true} onChange={(e) => onParam({ symmetric: e.target.checked })} /> symmetric pair
          </label>
        </div>
      );
    case 'bjt':
      return (
        <div className="ctl">
          <label>Transistor</label>
          <div className="seg">
            {(['NPN', 'PNP'] as const).map((t) => (
              <button key={t} className={(p.bjt ?? 'NPN') === t ? 'on' : ''} onClick={() => onParam({ bjt: t })}>
                {t}
              </button>
            ))}
          </div>
        </div>
      );
    case 'opamp':
      return <LogRow label="Supply ±Vsat" value={p.vsat ?? 9} min={1} max={18} fmt={(v) => `${v.toFixed(1)} V`} onChange={(v) => onParam({ vsat: v })} />;
    case 'source': {
      const wave = p.wave ?? 'guitar';
      const WAVES: { id: NonNullable<ComponentParams['wave']>; label: string }[] = [
        { id: 'guitar', label: 'Input' },
        { id: 'sine', label: 'Sine' },
        { id: 'pulse', label: 'Pulse' },
        { id: 'noise', label: 'Noise' },
        { id: 'dc', label: 'DC rail' },
      ];
      return (
        <>
          <div className="ctl">
            <label>Source</label>
            <div className="seg">
              {WAVES.map((w) => (
                <button key={w.id} className={wave === w.id ? 'on' : ''} onClick={() => onParam({ wave: w.id })}>
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          {wave === 'dc' ? (
            <LogRow label="Rail voltage" value={p.amp ?? 9} min={1} max={18} fmt={(v) => `${v.toFixed(1)} V`} onChange={(v) => onParam({ amp: v })} />
          ) : (
            <LogRow
              label={wave === 'guitar' ? 'Input level' : 'Amplitude'}
              value={p.amp ?? 1}
              min={0.05}
              max={5}
              fmt={(v) => `${v.toFixed(2)}${wave === 'guitar' ? '×' : ' V'}`}
              onChange={(v) => onParam({ amp: v })}
            />
          )}
          {(wave === 'sine' || wave === 'pulse') && (
            <LogRow
              label="Frequency"
              value={p.freq ?? 1000}
              min={20}
              max={20000}
              fmt={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`)}
              onChange={(v) => onParam({ freq: v })}
            />
          )}
        </>
      );
    }
    default:
      return <div className="ctl-head">no adjustable values</div>;
  }
}
