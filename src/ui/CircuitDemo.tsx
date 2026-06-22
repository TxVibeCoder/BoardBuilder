/**
 * Live circuit demo — the Phase 1 payoff. Pick a starter circuit, hit Play, and the engine runs LIVE
 * in an AudioWorklet: a rich source signal drives the circuit, the scope shows the probe node, and
 * turning a knob changes the sound continuously while the scope updates in lock-step. This is the
 * functional proof of "hand-build a circuit, turn a knob, hear+see the change" (minus the drag-drop
 * board, which is the next milestone).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import circuitWorkletUrl from '../engine/worklets/circuit.worklet.ts?worker&url';
import { STARTER_CIRCUITS, type StarterCircuit, type StarterKnob } from '../data/starterCircuits';
import type { ComponentParams } from '../engine/dsp/netlist';
import { FLAG_FLOATING, FLAG_NONCONVERGED, FLAG_NONFINITE, FLAG_OPAMP_NO_FEEDBACK } from '../engine/dsp/mnaSystem';
import { formatOhms } from '../engine/units';
import './styles.css';

const SCOPE_W = 1600;
const SCOPE_H = 560;
const SRC_HZ = 110; // low, harmonically-rich "note" so filtering/clipping are clearly audible

function makeLimiterCurve(samples = 1024): Float32Array {
  const c = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 1.5) / Math.tanh(1.5);
  }
  return c;
}

/** Read a knob's current value out of the circuit's netlist (the source of truth). */
function knobValue(circuit: StarterCircuit, k: StarterKnob): number {
  const spec = circuit.netlist.components.find((s) => s.id === k.componentId);
  const v = spec?.params[k.param];
  return typeof v === 'number' ? v : k.min;
}

function fmtKnob(k: StarterKnob, v: number): string {
  if (k.param === 'R') return formatOhms(v);
  if (k.param === 'C') return `${(v * 1e9).toFixed(0)} nF`;
  return v.toFixed(2);
}

const FLAG_LABELS: { bit: number; text: string }[] = [
  { bit: FLAG_FLOATING, text: 'floating node' },
  { bit: FLAG_OPAMP_NO_FEEDBACK, text: 'op-amp has no feedback' },
  { bit: FLAG_NONCONVERGED, text: 'not converging' },
  { bit: FLAG_NONFINITE, text: 'unsolvable' },
];

export function CircuitDemo() {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [knobs, setKnobs] = useState<Record<string, number>>({});
  const [flags, setFlags] = useState(0);

  const circuit = STARTER_CIRCUITS[idx]!;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const inAnalyserRef = useRef<AnalyserNode | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // initialise the knob values whenever the circuit changes
  useEffect(() => {
    const init: Record<string, number> = {};
    for (const k of circuit.knobs) init[k.componentId] = knobValue(circuit, k);
    setKnobs(init);
    setFlags(0);
  }, [circuit]);

  const draw = useCallback(() => {
    const inAn = inAnalyserRef.current;
    const outAn = outAnalyserRef.current;
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!inAn || !outAn || !canvas || !g) return;
    const size = outAn.fftSize;
    const inBuf = new Float32Array(size);
    const outBuf = new Float32Array(size);
    inAn.getFloatTimeDomainData(inBuf);
    outAn.getFloatTimeDomainData(outBuf);

    // trigger on the output's first rising zero-crossing for a stable trace
    let start = 0;
    for (let i = 1; i < size - 1; i++) {
      if (outBuf[i - 1]! < 0 && outBuf[i]! >= 0) {
        start = i;
        break;
      }
    }
    const span = Math.min(Math.floor((3 * 48000) / SRC_HZ), size - start - 1);

    let peak = 0.05;
    for (let i = 0; i < size; i++) {
      const a = Math.abs(outBuf[i]!);
      const b = Math.abs(inBuf[i]!);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    const vScale = ((SCOPE_H / 2) * 0.92) / (peak * 1.15);
    const mid = SCOPE_H / 2;

    g.clearRect(0, 0, SCOPE_W, SCOPE_H);
    g.strokeStyle = '#2a2014';
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 1; k < 8; k++) {
      g.moveTo((k / 8) * SCOPE_W, 0);
      g.lineTo((k / 8) * SCOPE_W, SCOPE_H);
    }
    g.stroke();
    g.strokeStyle = '#4a3a24';
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(SCOPE_W, mid);
    g.stroke();

    const plot = (buf: Float32Array, color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let i = 0; i < span; i++) {
        const x = (i / (span - 1)) * SCOPE_W;
        const y = mid - (buf[start + i] ?? 0) * vScale;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    };
    plot(inBuf, '#6b5536', 3); // input signal (faint)
    plot(outBuf, '#ffcf6b', 4); // circuit output (bright)

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
  }, []);

  const start = useCallback(async () => {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(circuitWorkletUrl);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = SRC_HZ;
    const inGain = ctx.createGain();
    inGain.gain.value = 1; // the source's per-circuit `amp` does the trimming inside the engine

    const node = new AudioWorkletNode(ctx, 'boardbuilder-circuit', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; flags?: number };
      if (m.type === 'flags' && typeof m.flags === 'number') setFlags(m.flags);
    };
    node.port.postMessage({ type: 'load', netlist: circuit.netlist });

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
    rafRef.current = requestAnimationFrame(draw);
  }, [circuit, draw]);

  // when the circuit changes mid-play, relatch the worklet
  useEffect(() => {
    if (playing) nodeRef.current?.port.postMessage({ type: 'load', netlist: circuit.netlist });
  }, [circuit, playing]);

  useEffect(() => () => void ctxRef.current?.close(), []);

  const onKnob = (k: StarterKnob, value: number) => {
    setKnobs((prev) => ({ ...prev, [k.componentId]: value }));
    nodeRef.current?.port.postMessage({ type: 'set', id: k.componentId, params: { [k.param]: value } as Partial<ComponentParams> });
  };

  const activeFlags = FLAG_LABELS.filter((f) => (flags & f.bit) !== 0);

  return (
    <div className="wrap">
      <header>
        <h1>BoardBuilder</h1>
        <p className="sub">Live analog-circuit sandbox · pick a circuit, press Play, turn a knob — hear and see it change together.</p>
      </header>

      <div className="picker">
        {STARTER_CIRCUITS.map((c, i) => (
          <button key={c.id} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>
            {c.name}
          </button>
        ))}
      </div>

      <canvas ref={canvasRef} className="scope" width={SCOPE_W} height={SCOPE_H} />

      <div className="readout">
        <span>
          input <b>saw {SRC_HZ} Hz</b>
        </span>
        <span>
          output <b>probe node</b>
        </span>
        {activeFlags.map((f) => (
          <span key={f.bit} className="badge">
            ⚠ {f.text}
          </span>
        ))}
      </div>

      <button className={`play ${playing ? 'stop' : ''}`} onClick={() => (playing ? stop() : void start())}>
        {playing ? '■ Stop' : '▶ Play'}
      </button>

      <div className="controls">
        {circuit.knobs.map((k) => (
          <div className="ctl" key={k.componentId}>
            <label>
              {k.label} <span className="val">{fmtKnob(k, knobs[k.componentId] ?? k.min)}</span>
            </label>
            <input
              type="range"
              min={k.min}
              max={k.max}
              step={(k.max - k.min) / 500}
              value={knobs[k.componentId] ?? k.min}
              onChange={(e) => onKnob(k, Number(e.target.value))}
            />
          </div>
        ))}
      </div>

      <div className="teaches">
        <b>{circuit.name} —</b> {circuit.teaches}. <b>Try:</b> {circuit.tryThis}.
      </div>
    </div>
  );
}
