/**
 * Phase 0 viability spike UI (work order §10): hard-coded diode clipper, a scope, and live
 * audio — the whole point is to prove the solve→SEE→HEAR loop end to end. Turn DRIVE and the
 * scope flattens AND the sound grinds in lock-step. This is NOT the eyelet-board UI; it is the
 * throwaway proof that the engine + audio + visuals tie together before any board is built.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import diodeClipperUrl from '../engine/worklets/diodeClipper.worklet.ts?worker&url';
import {
  DIODE_MODELS,
  DIODE_ORDER,
  DiodeClipperCore,
  diodeIndexFromId,
  type DiodeId,
} from '../engine/dsp/diodeClipperCore';
import { formatOhms, formatVolts } from '../engine/units';

const F0 = 1000; // source sine frequency (Hz)
const SCOPE_W = 1600;
const SCOPE_H = 600;

/** Gentle tanh safety limiter so a high-drop diode (LED) can't hard-clip the speakers. */
function makeLimiterCurve(samples = 1024): Float32Array {
  const c = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
  }
  return c;
}

export function Phase0App() {
  const [playing, setPlaying] = useState(false);
  const [drive, setDrive] = useState(2.0); // V peak
  const [seriesR, setSeriesR] = useState(4700); // Ω
  const [diode, setDiode] = useState<DiodeId>('Si');
  const [symmetric, setSymmetric] = useState(true);
  const [outPeak, setOutPeak] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // audio graph (runtime-only)
  const ctxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const driveRef = useRef<GainNode | null>(null);
  const clipRef = useRef<AudioWorkletNode | null>(null);
  const inAnalyserRef = useRef<AnalyserNode | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // live param values, mirrored into refs so the draw/apply loop reads fresh values
  const paramsRef = useRef({ drive, seriesR, diode, symmetric });
  paramsRef.current = { drive, seriesR, diode, symmetric };

  const drawTraces = useCallback(
    (inArr: Float32Array, outArr: Float32Array, n: number, start: number, vRef: number) => {
      const canvas = canvasRef.current;
      const g = canvas?.getContext('2d');
      if (!canvas || !g) return;
      const W = SCOPE_W;
      const H = SCOPE_H;
      g.clearRect(0, 0, W, H);
      const mid = H / 2;
      const vScale = (H / 2) * 0.92 / vRef;
      const yOf = (v: number) => mid - v * vScale;

      // grid + center line
      g.strokeStyle = '#2a2014';
      g.lineWidth = 1;
      g.beginPath();
      for (let k = 1; k < 8; k++) {
        const x = (k / 8) * W;
        g.moveTo(x, 0);
        g.lineTo(x, H);
      }
      g.stroke();
      g.strokeStyle = '#4a3a24';
      g.beginPath();
      g.moveTo(0, mid);
      g.lineTo(W, mid);
      g.stroke();

      const plot = (arr: Float32Array, color: string, width: number) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * W;
          const y = yOf(arr[start + i] ?? 0);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      };

      plot(inArr, getComputedStyle(document.documentElement).getPropertyValue('--trace-in') || '#6b5536', 3);
      plot(outArr, getComputedStyle(document.documentElement).getPropertyValue('--trace-out') || '#ffcf6b', 4);
    },
    [],
  );

  /** Offline render (engine only) for the static scope when audio is stopped. */
  const drawStatic = useCallback(() => {
    const p = paramsRef.current;
    const core = new DiodeClipperCore({ seriesR: p.seriesR, diode: p.diode, symmetric: p.symmetric });
    const periods = 3;
    const fs = 48000;
    const n = Math.floor((periods * fs) / F0);
    const inArr = new Float32Array(n);
    const outArr = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const vin = p.drive * Math.sin((2 * Math.PI * F0 * i) / fs);
      inArr[i] = vin;
      const vout = core.processSample(vin);
      outArr[i] = vout;
      if (Math.abs(vout) > peak) peak = Math.abs(vout);
    }
    setOutPeak(peak);
    drawTraces(inArr, outArr, n, 0, Math.max(p.drive, 0.01) * 1.15);
  }, [drawTraces]);

  /** Push current control values into the live audio graph. */
  const applyParams = useCallback(() => {
    const p = paramsRef.current;
    const ctx = ctxRef.current;
    if (!ctx) return;
    driveRef.current?.gain.setTargetAtTime(p.drive, ctx.currentTime, 0.01);
    const node = clipRef.current;
    if (node) {
      node.parameters.get('seriesR')!.setValueAtTime(p.seriesR, ctx.currentTime);
      node.parameters.get('diode')!.setValueAtTime(diodeIndexFromId(p.diode), ctx.currentTime);
      node.parameters.get('symmetric')!.setValueAtTime(p.symmetric ? 1 : 0, ctx.currentTime);
    }
  }, []);

  const liveLoop = useCallback(() => {
    const inAn = inAnalyserRef.current;
    const outAn = outAnalyserRef.current;
    if (!inAn || !outAn) return;
    const size = inAn.fftSize;
    const inBuf = new Float32Array(size);
    const outBuf = new Float32Array(size);
    inAn.getFloatTimeDomainData(inBuf);
    outAn.getFloatTimeDomainData(outBuf);

    // trigger on the first rising zero-crossing of the input for a stable display
    let start = 0;
    for (let i = 1; i < size - 1; i++) {
      if (inBuf[i - 1]! < 0 && inBuf[i]! >= 0) {
        start = i;
        break;
      }
    }
    const periods = 3;
    const span = Math.min(Math.floor((periods * 48000) / F0), size - start - 1);

    let peak = 0;
    for (const v of outBuf) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    setOutPeak(peak);

    drawTraces(inBuf, outBuf, span, start, Math.max(paramsRef.current.drive, 0.01) * 1.15);
    rafRef.current = requestAnimationFrame(liveLoop);
  }, [drawTraces]);

  const stopAudio = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    oscRef.current?.stop();
    ctxRef.current?.close();
    ctxRef.current = null;
    oscRef.current = null;
    driveRef.current = null;
    clipRef.current = null;
    inAnalyserRef.current = null;
    outAnalyserRef.current = null;
    setPlaying(false);
    // redraw the static engine render once stopped
    requestAnimationFrame(() => drawStatic());
  }, [drawStatic]);

  const startAudio = useCallback(async () => {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(diodeClipperUrl);
    const p = paramsRef.current;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = F0;

    const driveGain = ctx.createGain();
    driveGain.gain.value = p.drive;

    const clip = new AudioWorkletNode(ctx, 'boardbuilder-diode-clipper', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    clip.parameters.get('seriesR')!.value = p.seriesR;
    clip.parameters.get('diode')!.value = diodeIndexFromId(p.diode);
    clip.parameters.get('symmetric')!.value = p.symmetric ? 1 : 0;

    const inAnalyser = ctx.createAnalyser();
    inAnalyser.fftSize = 2048;
    const outAnalyser = ctx.createAnalyser();
    outAnalyser.fftSize = 2048;

    const makeup = ctx.createGain();
    makeup.gain.value = 0.7;
    const limiter = ctx.createWaveShaper();
    // lib.dom types curve as Float32Array<ArrayBuffer>; our helper returns the wider
    // ArrayBufferLike. Same cast SynthStack uses for its master soft-clip curve.
    limiter.curve = makeLimiterCurve() as Float32Array<ArrayBuffer>;
    limiter.oversample = '2x';

    // graph: osc → drive → [inAnalyser tap] → clip → [outAnalyser tap] → makeup → limiter → out
    osc.connect(driveGain);
    driveGain.connect(inAnalyser);
    driveGain.connect(clip);
    clip.connect(outAnalyser);
    clip.connect(makeup);
    makeup.connect(limiter).connect(ctx.destination);

    osc.start();

    ctxRef.current = ctx;
    oscRef.current = osc;
    driveRef.current = driveGain;
    clipRef.current = clip;
    inAnalyserRef.current = inAnalyser;
    outAnalyserRef.current = outAnalyser;
    setPlaying(true);
    rafRef.current = requestAnimationFrame(liveLoop);
  }, [liveLoop]);

  // redraw static scope on mount and whenever a control changes while stopped;
  // push to the live graph while playing.
  useEffect(() => {
    if (playing) applyParams();
    else drawStatic();
  }, [drive, seriesR, diode, symmetric, playing, applyParams, drawStatic]);

  // cleanup on unmount
  useEffect(() => () => void ctxRef.current?.close(), []);

  const model = DIODE_MODELS[diode];

  return (
    <div className="wrap">
      <header>
        <h1>BoardBuilder — Phase 0</h1>
        <p className="sub">
          Diode clipper · 1 kHz sine in → clipped node out · solve → see → hear, all live.
        </p>
      </header>

      <canvas ref={canvasRef} className="scope" width={SCOPE_W} height={SCOPE_H} />

      <div className="readout">
        <span>
          input peak <b>{formatVolts(drive)}</b>
        </span>
        <span>
          output peak <b>{formatVolts(outPeak)}</b>
        </span>
        <span>
          diode <b>{model.label}</b> (≈{formatVolts(model.vf)} drop)
        </span>
        <span>
          clip <b>{symmetric ? 'symmetric' : 'asymmetric'}</b>
        </span>
      </div>

      <button className={`play ${playing ? 'stop' : ''}`} onClick={() => (playing ? stopAudio() : void startAudio())}>
        {playing ? '■ Stop' : '▶ Play'}
      </button>

      <div className="controls">
        <div className="ctl">
          <label>
            Drive <span className="val">{formatVolts(drive)}</span>
          </label>
          <input
            type="range"
            min={0.1}
            max={5}
            step={0.05}
            value={drive}
            onChange={(e) => setDrive(Number(e.target.value))}
          />
        </div>

        <div className="ctl">
          <label>
            Series R <span className="val">{formatOhms(seriesR)}</span>
          </label>
          <input
            type="range"
            min={220}
            max={47000}
            step={10}
            value={seriesR}
            onChange={(e) => setSeriesR(Number(e.target.value))}
          />
        </div>

        <div className="ctl">
          <label>Diode</label>
          <div className="seg">
            {DIODE_ORDER.map((id) => (
              <button key={id} className={diode === id ? 'on' : ''} onClick={() => setDiode(id)}>
                {id}
              </button>
            ))}
          </div>
        </div>

        <div className="ctl">
          <label>Topology</label>
          <div className="seg">
            <button className={symmetric ? 'on' : ''} onClick={() => setSymmetric(true)}>
              Symmetric
            </button>
            <button className={!symmetric ? 'on' : ''} onClick={() => setSymmetric(false)}>
              Asymmetric
            </button>
          </div>
        </div>
      </div>

      <div className="teaches">
        <b>What this teaches:</b> clipping = distortion; the diode drop sets the threshold.{' '}
        <b>Try:</b> push <b>Drive</b> up and watch the bright trace shear flat while it grinds — then
        switch <b>Si → LED</b> for more headroom and a harder edge, or flip to{' '}
        <b>Asymmetric</b> to hear the even-harmonic buzz.
      </div>
    </div>
  );
}
