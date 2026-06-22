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
  clusterSignature,
  computeEyelets,
  emptyBoard,
  isPlayable,
  moveComponent,
  removeComponent,
  toNetlist,
  updateParams,
  type BoardComponent,
  type BoardState,
} from './boardModel';
import type { ComponentKind, ComponentParams } from '../../engine/dsp/netlist';
import type { DiodeId } from '../../engine/dsp/constants';
import { FLAG_FLOATING, FLAG_NONFINITE, FLAG_OPAMP_NO_FEEDBACK } from '../../engine/dsp/mnaSystem';
import { formatOhms } from '../../engine/units';

const BOARD_W = 160; // mm
const BOARD_H = 92;
const SRC_HZ = 110;
const SCOPE_W = 1600;
const SCOPE_H = 320;

const PALETTE: { kind: ComponentKind; label: string }[] = [
  { kind: 'source', label: 'Source' },
  { kind: 'resistor', label: 'Resistor' },
  { kind: 'capacitor', label: 'Capacitor' },
  { kind: 'diode', label: 'Diode' },
  { kind: 'pot', label: 'Pot' },
  { kind: 'opamp', label: 'Op-Amp' },
  { kind: 'probe', label: 'Probe' },
];

const FLAG_BADGES: { bit: number; text: string }[] = [
  { bit: FLAG_FLOATING, text: 'floating node — a leg has no connection' },
  { bit: FLAG_OPAMP_NO_FEEDBACK, text: 'op-amp has no feedback path' },
  { bit: FLAG_NONFINITE, text: 'circuit unsolvable as wired' },
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

  const boardRef = useRef(board);
  boardRef.current = board;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const startingRef = useRef(false); // re-entrancy guard for the async start()
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const inAnalyserRef = useRef<AnalyserNode | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const eyelets = useMemo(() => computeEyelets(board), [board]);

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

  const clientToBoard = (e: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * BOARD_W, y: ((e.clientY - rect.top) / rect.height) * BOARD_H };
  };

  const startDrag = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const c = boardRef.current.components.find((k) => k.id === id);
    if (!c) return;
    const p = clientToBoard(e);
    dragRef.current = { id, dx: p.x - c.x, dy: p.y - c.y, moved: false };
    setSelected(id);
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = clientToBoard(e);
    d.moved = true;
    setBoard((b) => moveComponent(b, d.id, p.x - d.dx, p.y - d.dy));
  };

  // Ends a drag from pointerup OR a cancelled/lost-capture gesture (touch interruption, mid-drag
  // unmount) so the part never sticks to the cursor and a moved-then-cancelled drag still relatches.
  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    if (d.moved) relatch(); // re-wire only after the drag settles (the allowed relatch gap)
  };

  const addPart = (kind: ComponentKind) => {
    const b = boardRef.current;
    const spawnX = 14 + (b.nextId % 5) * 6;
    const next = addComponent(b, kind, spawnX, 14);
    setBoard(next);
    setSelected(next.components[next.components.length - 1]!.id);
    boardRef.current = next;
    relatch();
  };

  const deleteSelected = () => {
    if (!selected) return;
    setBoard((b) => removeComponent(b, selected));
    boardRef.current = removeComponent(boardRef.current, selected);
    setSelected(null);
    relatch();
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

  const sel = board.components.find((c) => c.id === selected) ?? null;
  const activeFlags = FLAG_BADGES.filter((f) => (flags & f.bit) !== 0);
  const dupSource = board.components.filter((c) => c.kind === 'source').length > 1;
  const dupProbe = board.components.filter((c) => c.kind === 'probe').length > 1;

  return (
    <div className="wrap board-wrap">
      <div className="board-bar">
        {PALETTE.map((p) => (
          <button key={p.kind} className="add" onClick={() => addPart(p.kind)}>
            + {p.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="add" disabled={!selected} onClick={deleteSelected}>
          🗑 Delete
        </button>
        <button className={`play ${playing ? 'stop' : ''}`} onClick={() => (playing ? stop() : void start())}>
          {playing ? '■ Stop' : '▶ Play'}
        </button>
      </div>

      <svg
        ref={svgRef}
        className="board"
        viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
        style={{ aspectRatio: `${BOARD_W} / ${BOARD_H}` }}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onPointerDown={() => setSelected(null)}
      >
        <rect x={0} y={0} width={BOARD_W} height={BOARD_H} fill="#c8a86a" rx={2} />
        {/* board-level leads: each pin soldered to its eyelet centroid */}
        {eyelets.flatMap((e) =>
          e.pins.map((p) => <line key={`${p.componentId}:${p.pinIndex}-lead`} x1={p.x} y1={p.y} x2={e.x} y2={e.y} stroke="#c9cdd2" strokeWidth={0.4} strokeLinecap="round" />),
        )}
        {/* components */}
        {board.components.map((c) => {
          const art = artFor(c.kind)?.(c.params);
          if (!art) return null;
          return (
            <g key={c.id}>
              <image href={artUri(art)} x={c.x} y={c.y} width={art.width} height={art.height} />
              {selected === c.id && <rect x={c.x - 0.6} y={c.y - 0.6} width={art.width + 1.2} height={art.height + 1.2} fill="none" stroke="#e0552b" strokeWidth={0.4} strokeDasharray="1.2 0.8" rx={0.8} />}
              <rect x={c.x} y={c.y} width={art.width} height={art.height} fill="transparent" style={{ cursor: 'grab' }} onPointerDown={(e) => startDrag(e, c.id)} />
            </g>
          );
        })}
        {/* eyelets on top: gold solder blob (≥2 legs) or open brass ring (1 leg) */}
        {eyelets.map((e) =>
          e.pins.length >= 2 ? (
            <circle key={e.id} cx={e.x} cy={e.y} r={1.15} fill="#e8b54a" stroke="#8a6420" strokeWidth={0.25} />
          ) : (
            <circle key={e.id} cx={e.x} cy={e.y} r={1.0} fill="#1d150c" stroke="#caa15a" strokeWidth={0.45} />
          ),
        )}
      </svg>

      <div className="board-hint">
        Drop parts from the palette, then drag a leg onto another leg — they fuse into a gold eyelet (one node). Add a{' '}
        <b>Source</b> and a <b>Probe</b>, press <b>Play</b>, and turn a value.
        {activeFlags.map((f) => (
          <span key={f.bit} className="badge">
            ⚠ {f.text}
          </span>
        ))}
        {dupSource && <span className="badge">⚠ multiple sources — only the first is used</span>}
        {dupProbe && <span className="badge">⚠ multiple probes — only the first is scoped</span>}
      </div>

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
    case 'opamp':
      return <LogRow label="Supply ±Vsat" value={p.vsat ?? 9} min={1} max={18} fmt={(v) => `${v.toFixed(1)} V`} onChange={(v) => onParam({ vsat: v })} />;
    case 'source':
      return <LogRow label="Input level" value={p.amp ?? 1} min={0.05} max={5} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => onParam({ amp: v })} />;
    default:
      return <div className="ctl-head">no adjustable values</div>;
  }
}
