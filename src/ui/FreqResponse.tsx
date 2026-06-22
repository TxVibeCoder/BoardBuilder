/**
 * FreqResponse — the Phase 2 "frequency-response" teaching view. Feed it the current board's netlist
 * and it sweeps |H(f)| offline (pure `frequencyResponse`, NO Web Audio), then draws a Bode MAGNITUDE
 * plot on a <canvas>: log-frequency x-axis with decade gridlines + labels, dB y-axis. Drop an RC and
 * you see the −3 dB corner and the slope; turn a knob upstream and re-render to watch the corner move.
 *
 * Drawing mirrors the scope style in CircuitDemo.tsx (canvas 2d, the project's amber-on-dark palette).
 */

import { useEffect, useRef, useState } from 'react';
import { createSweep, type FreqResponsePoint } from '../engine/dsp/frequencyResponse';
import type { Netlist } from '../engine/dsp/netlist';
import './styles.css';

const PLOT_W = 1600;
const PLOT_H = 560;
const PAD_L = 70; // room for the dB axis labels
const PAD_R = 24;
const PAD_T = 24;
const PAD_B = 44; // room for the Hz axis labels

const F_MIN = 20;
const F_MAX = 20000;

// palette (kept in sync with styles.css :root — canvas can't read CSS vars cheaply)
const COL_BG = '#120d09';
const COL_GRID = '#2a2014';
const COL_GRID_HI = '#4a3a24';
const COL_TRACE = '#ffcf6b';
const COL_LABEL = '#b39b78';

/** Plot bounds for the dB axis: a "nice" rounded range that always contains the data and 0 dB. */
function dbBounds(points: FreqResponsePoint[]): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const p of points) {
    if (Number.isFinite(p.db)) {
      if (p.db < lo) lo = p.db;
      if (p.db > hi) hi = p.db;
    }
  }
  // pad and snap to 6 dB steps; floor at −72 dB so a deep null doesn't squash the useful range
  lo = Math.max(-72, Math.floor((lo - 3) / 6) * 6);
  hi = Math.ceil((hi + 3) / 6) * 6;
  if (hi - lo < 12) hi = lo + 12;
  return { lo, hi };
}

const log10 = (x: number): number => Math.log(x) / Math.LN10;

export function FreqResponse({ netlist }: { netlist: Netlist }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The sweep runs CircuitCore offline at many frequencies — potentially heavy for a nonlinear circuit.
  // Compute it INCREMENTALLY (≤10 ms of work per animation frame) so clicking "Response" never freezes
  // the UI; the trace fills in over a few frames and `progress` drives a small status readout.
  const [points, setPoints] = useState<FreqResponsePoint[]>([]);
  const [progress, setProgress] = useState(0); // 0..1

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const sweep = createSweep(netlist, { fMin: F_MIN, fMax: F_MAX, points: 48 });
    const total = sweep.freqs.length;
    const acc: FreqResponsePoint[] = [];
    let i = 0;
    setPoints([]);
    setProgress(0);
    // setTimeout (not requestAnimationFrame) so the compute keeps advancing even when the tab isn't
    // painting; each slice is bounded to ~10 ms so the main thread never blocks long enough to freeze.
    const step = (): void => {
      if (cancelled) return;
      const t0 = performance.now();
      while (i < total && performance.now() - t0 < 10) acc.push(sweep.measure(i++));
      setPoints(acc.slice());
      setProgress(i / total);
      if (i < total) timer = window.setTimeout(step, 0);
    };
    timer = window.setTimeout(step, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [netlist]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;

    const x0 = PAD_L;
    const x1 = PLOT_W - PAD_R;
    const y0 = PAD_T;
    const y1 = PLOT_H - PAD_B;
    const lf0 = log10(F_MIN);
    const lf1 = log10(F_MAX);
    const { lo, hi } = dbBounds(points);

    const xOf = (hz: number): number => x0 + ((log10(hz) - lf0) / (lf1 - lf0)) * (x1 - x0);
    const yOf = (db: number): number => y1 - ((db - lo) / (hi - lo)) * (y1 - y0);

    g.clearRect(0, 0, PLOT_W, PLOT_H);
    g.fillStyle = COL_BG;
    g.fillRect(0, 0, PLOT_W, PLOT_H);

    // vertical gridlines: every 1-2-5…-decade step across the log axis, decade boundaries brighter
    g.font = '20px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let dec = Math.floor(lf0); dec < lf1; dec++) {
      const base = Math.pow(10, dec);
      for (let m = 1; m < 10; m++) {
        const hz = base * m;
        if (hz < F_MIN || hz > F_MAX) continue;
        const x = xOf(hz);
        const decade = m === 1;
        g.strokeStyle = decade ? COL_GRID_HI : COL_GRID;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, y0);
        g.lineTo(x, y1);
        g.stroke();
        if (decade || m === 2 || m === 5) {
          const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
          g.fillStyle = COL_LABEL;
          g.fillText(label, x, y1 + 8);
        }
      }
    }

    // horizontal gridlines + dB labels, every 6 dB; 0 dB gets the brighter "unity" line
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let db = lo; db <= hi; db += 6) {
      const y = yOf(db);
      g.strokeStyle = db === 0 ? COL_GRID_HI : COL_GRID;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x0, y);
      g.lineTo(x1, y);
      g.stroke();
      g.fillStyle = COL_LABEL;
      g.fillText(`${db}`, x0 - 10, y);
    }

    // axis titles
    g.fillStyle = COL_LABEL;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('frequency (Hz)', (x0 + x1) / 2, PLOT_H - 4);
    g.save();
    g.translate(18, (y0 + y1) / 2);
    g.rotate(-Math.PI / 2);
    g.fillText('magnitude (dB)', 0, 0);
    g.restore();

    // the magnitude trace (bright amber, matching the scope's output trace)
    g.strokeStyle = COL_TRACE;
    g.lineWidth = 4;
    g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    for (const p of points) {
      if (!Number.isFinite(p.db)) continue;
      const x = xOf(p.hz);
      const y = Math.max(y0, Math.min(y1, yOf(p.db)));
      if (!started) {
        g.moveTo(x, y);
        started = true;
      } else {
        g.lineTo(x, y);
      }
    }
    g.stroke();

    // progress readout while the sweep is still filling in (top-right of the plot)
    if (progress < 1) {
      g.fillStyle = COL_LABEL;
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.font = '20px system-ui, sans-serif';
      g.fillText(`sweeping… ${Math.round(progress * 100)}%`, x1, y0 + 2);
    }
  }, [points, progress]);

  return <canvas ref={canvasRef} className="scope" width={PLOT_W} height={PLOT_H} />;
}
