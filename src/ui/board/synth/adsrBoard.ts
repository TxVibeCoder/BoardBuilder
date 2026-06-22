/**
 * adsrBoard — a gated ENVELOPE → VCA synth voice, as a ready-to-load BoardState.
 *
 * The classic "amp envelope" lesson, wired from real parts: a GATE (a slow `pulse` source, ~2 Hz)
 * drives a diode-pumped envelope cap, and that slowly rising/falling envelope VOLTAGE opens and closes
 * a transistor VCA that lets an audio tone (a ~220 Hz `sine` source) through. The output amplitude
 * literally TRACKS the gate — loud while the gate is high (cap charged, transistor biased on), fading
 * to near-silence while the gate is low (cap drained, transistor cut off). That is what an envelope
 * generator + VCA does in every analog synth, here as solvable nodal hardware you can see and hear.
 *
 * Signal flow (left → right):
 *   ENVELOPE GENERATOR
 *     GATE (pulse, 2 Hz, ±9 V) ─► Dchg (diode) ─► Renv ─► [ENV cap to gnd] ─► [Rrel to gnd]
 *       The diode passes only the gate's positive half: the cap charges FAST through Renv on the high
 *       phase (attack), and when the gate goes low the diode blocks, so the cap drains SLOWLY through
 *       Rrel (release). The ENV node is therefore a smooth, unipolar envelope that follows the gate.
 *   VCA (NPN common-emitter, biased by the envelope)
 *     VCC (dc, 9 V) ─► Rc ─► collector;  emitter ─► Re ─► gnd
 *     The ENV node sets the base bias through Rbias. With the envelope HIGH the base sits ~Vbe above the
 *     emitter and the transistor conducts → the AC tone modulates the collector. With the envelope LOW
 *     the base falls below cut-off → the transistor is off → the tone is squelched. So the envelope
 *     gates the audio: a voltage-controlled amplifier.
 *   AUDIO
 *     TONE (sine, 220 Hz, small amp) ─► Cin ─► base (AC-coupled, rides on the envelope bias)
 *     collector ─► Cout ─► [Rload to gnd] ─► PROBE   (AC-coupled output; blocks the DC bias)
 *
 * Pure data — no Web Audio, no DOM. `toNetlist(board)` derives the engine netlist exactly as a
 * hand-built board would. Verified by test/unit/adsrBoard.test.ts (gate-high RMS ≫ gate-low RMS).
 */

import { makeBoard } from '../boardBuild';
import type { BoardState } from '../boardModel';

export const id = 'adsr';
export const name = 'Envelope + VCA (gated voice)';
export const teaches =
  'a gate charges an envelope cap through a diode (fast attack), which then drains slowly through a ' +
  'resistor (release); that envelope voltage biases a transistor VCA on and off, so the audio tone ' +
  'gets LOUDER while the gate is high and fades to silence while it is low — see the amplitude track ' +
  'the gate, the heart of an analog synth voice.';

/** Build the gated-envelope → VCA voice as a BoardState (parts placed in signal-flow order + wires). */
export function build(): BoardState {
  return makeBoard(
    [
      // --- envelope generator (top-left → centre) ---
      // GATE: a slow bipolar square (~2 Hz). Its positive half opens the envelope; the negative half lets it decay.
      // Gate amp is deliberately MODEST (±3.5 V): the envelope peak must keep the VCA transistor in its
      // active region (so the tone swings), not slam it into saturation (which would squelch the tone).
      { id: 'GATE', kind: 'source', x: 6, y: 8, params: { wave: 'pulse', freq: 2, amp: 3.5, rsrc: 100 } },
      { id: 'Dchg', kind: 'diode', x: 30, y: 10, params: { diode: 'Si', symmetric: false } }, // one-way charge path (attack)
      { id: 'Renv', kind: 'resistor', x: 50, y: 10, params: { R: 2200 } }, // attack series R (small ⇒ fast charge)
      { id: 'Cenv', kind: 'capacitor', x: 70, y: 26, params: { C: 1e-5 } }, // envelope hold cap (10 µF)
      { id: 'Rrel', kind: 'resistor', x: 86, y: 26, params: { R: 4700 }, rot: 90 }, // release bleed to gnd (τ≈47 ms ⇒ drains to cut-off each low phase)
      { id: 'Rbias', kind: 'resistor', x: 70, y: 44 }, // envelope → base bias (10k default)

      // --- VCA: NPN common-emitter biased BY the envelope ---
      { id: 'VCC', kind: 'source', x: 6, y: 56, params: { wave: 'dc', amp: 9 } }, // collector supply rail
      { id: 'Rc', kind: 'resistor', x: 96, y: 50, params: { R: 4700 }, rot: 90 }, // collector load (vertical, up to Vcc)
      { id: 'Re', kind: 'resistor', x: 96, y: 78, params: { R: 2200 }, rot: 90 }, // emitter degeneration: bounds Ic so the peak envelope stays active, not saturated
      { id: 'Q', kind: 'bjt', x: 106, y: 62, params: { bjt: 'NPN' }, rot: 90 }, // collector up / base mid / emitter down

      // --- audio tone in, AC-coupled to the base ---
      { id: 'TONE', kind: 'source', x: 6, y: 80, params: { wave: 'sine', freq: 220, amp: 0.05, rsrc: 1000 } },
      { id: 'Cin', kind: 'capacitor', x: 40, y: 78, params: { C: 1e-6 } }, // input coupling (passes the AC tone onto the bias)

      // --- AC-coupled output to the probe ---
      { id: 'Cout', kind: 'capacitor', x: 124, y: 56, params: { C: 1e-7 } }, // blocks the DC bias; passes the gated tone
      { id: 'Rload', kind: 'resistor', x: 134, y: 78, params: { R: 100000 }, rot: 90 }, // output load (DC path for Cout)
      { id: 'PRB', kind: 'probe', x: 150, y: 58 },
    ],
    [
      // ground rail: VCC.gnd — GATE.gnd — TONE.gnd — Cenv.b — Rrel.b — Re.b — Rload.b
      ['VCC', 'gnd', 'GATE', 'gnd'],
      ['VCC', 'gnd', 'TONE', 'gnd'],
      ['VCC', 'gnd', 'Cenv', 'b'],
      ['VCC', 'gnd', 'Rrel', 'b'],
      ['VCC', 'gnd', 'Re', 'b'],
      ['VCC', 'gnd', 'Rload', 'b'],

      // envelope generator: GATE.hot — Dchg.a (anode);  Dchg.k — Renv.a;  Renv.b — ENV node
      ['GATE', 'hot', 'Dchg', 'a'],
      ['Dchg', 'k', 'Renv', 'a'],
      // ENV node = Renv.b — Cenv.a — Rrel.a — Rbias.a
      ['Renv', 'b', 'Cenv', 'a'],
      ['Renv', 'b', 'Rrel', 'a'],
      ['Renv', 'b', 'Rbias', 'a'],

      // base node = Rbias.b — Cin.b — Q.b  (envelope bias + AC tone meet at the base)
      ['Rbias', 'b', 'Q', 'b'],
      ['Cin', 'b', 'Q', 'b'],

      // VCC rail: VCC.hot — Rc.a
      ['VCC', 'hot', 'Rc', 'a'],
      // collector: Rc.b — Q.c — Cout.a
      ['Rc', 'b', 'Q', 'c'],
      ['Q', 'c', 'Cout', 'a'],
      // emitter: Q.e — Re.a
      ['Q', 'e', 'Re', 'a'],

      // audio in: TONE.hot — Cin.a
      ['TONE', 'hot', 'Cin', 'a'],

      // AC-coupled output: Cout.b — Rload.a — probe
      ['Cout', 'b', 'Rload', 'a'],
      ['Cout', 'b', 'PRB', 'tip'],
    ],
  );
}
