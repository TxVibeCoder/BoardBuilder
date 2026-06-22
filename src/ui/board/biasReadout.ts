/**
 * Bias readout — the PURE DC operating-point probe for the board (Phase 2 instrumentation, the "see"
 * half of see+hear). Builds a {@link CircuitCore} on the board's netlist, settles it at zero input (the
 * DC bias: caps charged, inductors at steady state, the source's `dc` rail standing), and reads every
 * eyelet's solved voltage at its centroid so the UI can label the board with what each node sits at.
 *
 * No Web Audio, no DOM — node voltages are literally volts (vv == V). The renderer ({@link BiasOverlay})
 * is a pure function of this; the netlist stays the single source of truth.
 */

import { CircuitCore } from '../../engine/dsp/circuitCore';
import { computeEyelets, toNetlist, type BoardState } from './boardModel';

/** A settled DC voltage at one eyelet, positioned at its centroid (mm) for a label. */
export interface BiasPoint {
  eyeletId: string;
  x: number; // eyelet centroid (mm)
  y: number;
  volts: number;
}

/** Samples to run at zero input so reactive history settles to the DC operating point. At 48 kHz this
 *  is ~43 ms — far longer than any in-band RC corner, so caps fully charge and the rail stands. */
const SETTLE_SAMPLES = 2048;

/**
 * Solve the board's DC operating point and return each eyelet's settled voltage at its centroid.
 * Returns [] when the circuit has no ground reference (`!core.groundOk`) — an ungrounded board has no
 * meaningful absolute voltages (that's the floating-node teaching moment, surfaced elsewhere as a flag).
 */
export function computeBias(board: BoardState): BiasPoint[] {
  const core = new CircuitCore(toNetlist(board), board.sampleRate);
  if (!core.groundOk) return [];

  // settle: feed extIn = 0 for a block so any 'guitar' source rests at 0 V and reactive parts converge.
  const zeros = new Float64Array(SETTLE_SAMPLES);
  const out = new Float64Array(SETTLE_SAMPLES);
  core.processBlock(zeros, out, SETTLE_SAMPLES);

  return computeEyelets(board).map((e) => ({
    eyeletId: e.id,
    x: e.x,
    y: e.y,
    volts: core.nodeVoltage(e.id),
  }));
}
