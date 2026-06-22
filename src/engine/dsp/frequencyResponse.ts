/**
 * frequencyResponse — a PURE offline analyzer (no Web Audio): the magnitude response |H(f)| of a
 * circuit, swept log-spaced across the audio band. This is the data behind the "frequency-response"
 * teaching view (Phase 2 instrumentation): drop an RC, sweep it, see the −3 dB corner and the slope.
 *
 * Method (mirrors the `gainAt` helper in test/unit/circuitCore.test.ts): for each frequency, clone the
 * netlist (NEVER mutate the input), force the FIRST source to a unit-amplitude `wave:'sine'` at that
 * frequency, run `CircuitCore` offline long enough to reach steady state, then measure
 * |H| = outRMS / inRMS over an integer number of cycles in the TAIL. inRMS = amp/√2 for a sine.
 * db = 20·log10(|H|).
 */

import { CircuitCore } from './circuitCore';
import { cloneNetlist, type Netlist } from './netlist';

export interface FreqResponsePoint {
  hz: number; // sweep frequency (Hz)
  gain: number; // |H(f)| linear magnitude (outRMS / inRMS)
  db: number; // 20·log10(gain)
}

export interface FreqResponseOpts {
  fMin?: number; // sweep start (Hz), default 20
  fMax?: number; // sweep end (Hz), default 20000
  points?: number; // log-spaced point count, default 60
  amp?: number; // sine drive amplitude (V), default 1
}

/** A prepared sweep: the list of frequencies plus a per-point `measure(i)`. Lets a UI compute the sweep
 *  INCREMENTALLY (a few points per animation frame) so a heavy nonlinear circuit never freezes the
 *  main thread — `frequencyResponse` below is just the synchronous "measure them all" convenience. */
export interface Sweep {
  freqs: number[];
  measure: (i: number) => FreqResponsePoint;
}

export function createSweep(netlist: Netlist, opts: FreqResponseOpts = {}): Sweep {
  const fMin = opts.fMin ?? 20;
  const fMax = opts.fMax ?? 20000;
  const points = opts.points ?? 60;
  const amp = opts.amp ?? 1;

  // clone + force the SIGNAL source to a sine drive we control; don't mutate the caller's netlist.
  // Prefer the 'guitar' (audio-input) source so multi-source circuits — e.g. a transistor amp with a
  // separate 'dc' Vcc rail — are swept at their INPUT and the rail is left intact; else the first source.
  const work = cloneNetlist(netlist);
  const src = work.components.find((c) => c.kind === 'source' && c.params.wave === 'guitar') ?? work.components.find((c) => c.kind === 'source');
  if (src) {
    src.params.wave = 'sine';
    src.params.amp = amp;
    src.params.rsrc = src.params.rsrc ?? 1e-6; // near-ideal drive (matches the test sine source)
  }

  const fs = work.sampleRate || 48000;
  // oversample:1 — a magnitude reading at the fundamental needs no anti-aliasing, and this is the
  // single biggest speedup (a nonlinear circuit would otherwise solve 4–8× per sample over the sweep).
  const core = new CircuitCore(work, fs, { oversample: 1 });
  const inRms = amp / Math.SQRT2; // RMS of a sine of amplitude `amp`

  const freqs: number[] = [];
  for (let k = 0; k < points; k++) {
    const t = points > 1 ? k / (points - 1) : 0; // log-spaced (geometric); single point sits at fMin
    freqs.push(fMin * Math.pow(fMax / fMin, t));
  }

  const measure = (i: number): FreqResponsePoint => {
    const hz = freqs[i]!;
    const gain = src ? measureGain(core, src.id, hz, fs, inRms) : 0;
    return { hz, gain, db: 20 * Math.log10(Math.max(gain, 1e-12)) };
  };
  return { freqs, measure };
}

/**
 * Sweep |H(f)| of `netlist` across `points` log-spaced frequencies in [fMin, fMax] (synchronous). The
 * input is left untouched (a clone is driven). The first `source` is forced to a unit-amplitude sine at
 * each frequency; circuits with no source return zero-gain points rather than throwing.
 */
export function frequencyResponse(netlist: Netlist, opts: FreqResponseOpts = {}): FreqResponsePoint[] {
  const sweep = createSweep(netlist, opts);
  return sweep.freqs.map((_, i) => sweep.measure(i));
}

/**
 * Steady-state |H| at one frequency, mirroring `gainAt` in the circuitCore test: set the source freq,
 * reset warm-start/history, run ~8 cycles plus a 50 ms settle, then take the RMS over the tail and
 * divide by the input RMS. The run length is CAPPED (very low frequencies would otherwise need tens of
 * thousands of samples per point) — teaching-fidelity magnitude, not lab-grade.
 */
function measureGain(core: CircuitCore, srcId: string, hz: number, fs: number, inRms: number): number {
  core.setValue(srcId, { freq: hz });
  core.reset();
  const period = fs / hz;
  const N = Math.min(Math.ceil(8 * period + fs * 0.05), 4096); // cap so low-f points stay cheap (snappy sweep)
  const inb = new Float64Array(N); // sine source drives itself; extIn unused for wave:'sine'
  const outb = new Float64Array(N);
  core.processBlock(inb, outb, N);
  // Measure over a WHOLE number of cycles in the tail — a partial-cycle window skews the RMS (a low-f
  // point can read >1). Take up to 6 cycles, but only as many as fit in the back 60% of the (capped) run.
  const cycles = Math.max(1, Math.min(6, Math.floor((N * 0.6) / period)));
  const M = Math.max(1, Math.min(N - 1, Math.round(cycles * period)));
  let s = 0;
  for (let i = N - M; i < N; i++) s += outb[i]! * outb[i]!;
  const rms = Math.sqrt(s / M);
  return rms / inRms;
}
