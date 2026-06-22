/**
 * VCO premade — an astable multivibrator built from two cross-coupled NPN transistors. The classic
 * "two transistors take turns" oscillator: each collector drives the OTHER base through a timing cap,
 * so the pair flip-flops and the collector swings square between ~0 V and the Vcc rail. No input is
 * needed — it self-oscillates off the Vcc rail; the output is one collector AC-coupled to a load + probe.
 *
 * Frequency ≈ 1 / (0.69·(Rb1·C1 + Rb2·C2)). With Rb ≈ 48 kΩ and C ≈ 68/82 nF this lands in the audio
 * band (~200 Hz, measured 195 Hz in test/unit/vcoBoard.test.ts).
 *
 * Two start-up insurances make the solve deterministic (a perfectly symmetric astable has an unstable
 * DC equilibrium the nodal solver can sit on forever): the two halves are slightly ASYMMETRIC
 * (C1 = 68 nF vs C2 = 82 nF) AND a tiny white-noise source is coupled to one base through a large series
 * resistance (rsrc = 1 MΩ, so it nudges the bias point without clamping it) to kick the latch off centre.
 *
 * Pure data — no Web Audio, no DOM. Same shape as the `premadeBoards.ts` entries; `toNetlist(build())`
 * derives the engine netlist exactly as a hand-wired board would.
 */

import { makeBoard } from '../boardBuild';
import type { BoardState } from '../boardModel';

/** A premade circuit: id + name + one-line teaching note + a builder that returns a fresh BoardState. */
export interface PremadeCircuit {
  id: string;
  name: string;
  teaches: string;
  build: () => BoardState;
}

export const vcoBoard: PremadeCircuit = {
  id: 'vco',
  name: 'VCO (astable multivibrator)',
  teaches:
    'two cross-coupled transistors take turns switching, flip-flopping into a square-wave oscillator. ' +
    'Pitch ≈ 1/(0.69·(Rb·C)) — shrink the timing caps or the base resistors and the note rises. No input: ' +
    'it makes its own tone straight off the Vcc rail.',
  build: (): BoardState =>
    makeBoard(
      [
        // Supply rail + ground references (two dc sources: Vcc = 9 V, an explicit 0 V ground tie).
        { id: 'VCC', kind: 'source', x: 6, y: 6, params: { wave: 'dc', amp: 9 } }, // supply rail (top-left)
        { id: 'GND', kind: 'source', x: 6, y: 80, params: { wave: 'dc', amp: 0 } }, // 0 V ground reference (bottom-left)
        // Start-up kick: tiny white noise through a HIGH series R (1 MΩ) — perturbs base-1's bias point
        // enough to break the symmetric latch, without clamping the node (a near-ideal source would).
        { id: 'NOI', kind: 'source', x: 6, y: 42, params: { wave: 'noise', amp: 1e-3, rsrc: 1e6 } },
        // Collector loads (Vcc → collector) — the square output is taken across one of these.
        { id: 'Rc1', kind: 'resistor', x: 40, y: 10, rot: 90, params: { R: 1000 } },
        { id: 'Rc2', kind: 'resistor', x: 110, y: 10, rot: 90, params: { R: 1000 } },
        // Base pull-ups (Vcc → base) — these + the timing caps set the flip period (and the pitch).
        { id: 'Rb1', kind: 'resistor', x: 55, y: 10, rot: 90, params: { R: 48000 } },
        { id: 'Rb2', kind: 'resistor', x: 95, y: 10, rot: 90, params: { R: 48000 } },
        // Timing caps — DELIBERATELY unequal (68 nF vs 82 nF) so the two halves can't sit balanced.
        { id: 'C1', kind: 'capacitor', x: 60, y: 42, params: { C: 68e-9 } }, // collector-1 → base-2
        { id: 'C2', kind: 'capacitor', x: 90, y: 42, params: { C: 82e-9 } }, // collector-2 → base-1
        // The cross-coupled pair (emitters to ground; rotated leads not needed — wired by pin name).
        { id: 'Q1', kind: 'bjt', x: 45, y: 58, params: { bjt: 'NPN' } },
        { id: 'Q2', kind: 'bjt', x: 100, y: 58, params: { bjt: 'NPN' } },
        // Output stage: AC-couple collector-2 to a load resistor (DC path for Cout) + the probe.
        { id: 'Cout', kind: 'capacitor', x: 130, y: 42, params: { C: 1e-6 } }, // output coupling (blocks the DC bias)
        { id: 'Rload', kind: 'resistor', x: 140, y: 60, rot: 90, params: { R: 100000 } },
        { id: 'PRB', kind: 'probe', x: 150, y: 30 },
      ],
      [
        // Vcc rail: VCC.hot — Rc1.a — Rc2.a — Rb1.a — Rb2.a
        ['VCC', 'hot', 'Rc1', 'a'],
        ['VCC', 'hot', 'Rc2', 'a'],
        ['VCC', 'hot', 'Rb1', 'a'],
        ['VCC', 'hot', 'Rb2', 'a'],
        // Ground net: VCC.gnd — GND(both pins, 0 V) — NOI.gnd — both emitters — Rload.b
        ['VCC', 'gnd', 'GND', 'gnd'],
        ['VCC', 'gnd', 'GND', 'hot'],
        ['VCC', 'gnd', 'NOI', 'gnd'],
        ['VCC', 'gnd', 'Q1', 'e'],
        ['VCC', 'gnd', 'Q2', 'e'],
        ['VCC', 'gnd', 'Rload', 'b'],
        // Collector-1 node: Rc1.b — Q1.c — C1.a
        ['Rc1', 'b', 'Q1', 'c'],
        ['Q1', 'c', 'C1', 'a'],
        // Base-2 node: Rb2.b — Q2.b — C1.b  (collector-1 drives base-2)
        ['Rb2', 'b', 'Q2', 'b'],
        ['Q2', 'b', 'C1', 'b'],
        // Collector-2 node: Rc2.b — Q2.c — C2.a
        ['Rc2', 'b', 'Q2', 'c'],
        ['Q2', 'c', 'C2', 'a'],
        // Base-1 node: Rb1.b — Q1.b — C2.b — NOI.hot  (collector-2 drives base-1; noise kick injected here)
        ['Rb1', 'b', 'Q1', 'b'],
        ['Q1', 'b', 'C2', 'b'],
        ['NOI', 'hot', 'Q1', 'b'],
        // Output: collector-2 — Cout — Rload.a / probe
        ['Q2', 'c', 'Cout', 'a'],
        ['Cout', 'b', 'Rload', 'a'],
        ['Cout', 'b', 'PRB', 'tip'],
      ],
    ),
};
