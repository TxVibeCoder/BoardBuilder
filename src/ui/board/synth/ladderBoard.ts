/**
 * Transistor voltage-controlled LOW-PASS filter — a premade synth board (a "ladder").
 *
 * The Moog sound is a 4-stage transistor ladder: cascaded NPN differential pairs whose shunt caps
 * integrate a tail current, with the tail current (set by a resistor to ground) acting as the cutoff
 * control. That full differential-pair ladder does not bias or filter cleanly in this teaching solver
 * — its DC operating point is too delicate for the freeform Ebers-Moll model with no dedicated tail
 * current source — so this board ships the robust, learnable cousin that captures the same idea:
 *
 *   a cascade of TWO emitter-follower (common-collector) buffered RC poles.
 *
 * Each NPN transistor is a unity-gain buffer that drives an RC pole (series R into a shunt cap to
 * ground) into the high-impedance base of the next stage, so each pole sees a fresh low-impedance
 * drive and doesn't load the one before it — exactly why a ladder cascades stages instead of just
 * stacking RCs. Two buffered poles give a clean ~12 dB/oct low-pass; the series resistors (Rp1/Rp2)
 * set the corner (cutoff ≈ 1/(2π·R·C)) — turn them down to open the filter up, up to close it down.
 * A Vcc rail + a base divider biases stage 1 around mid-rail; stage 1's emitter (already mid-rail)
 * DC-couples straight into stage 2's base.
 *
 * Pure data — no Web Audio, no DOM. `toNetlist(board)` derives the engine netlist exactly as a
 * hand-built board would. The low-pass behaviour is verified in test/unit/ladderBoard.test.ts.
 */

import { makeBoard } from '../boardBuild';
import type { BoardState } from '../boardModel';

export interface SynthBoard {
  id: string;
  name: string;
  teaches: string;
  build: () => BoardState;
}

// Default corner ≈ 1/(2π·Rp·Cp) = 1/(2π·16k·10n) ≈ 1 kHz — a musical default sweepable by Rp1/Rp2.
const RP = 16000; // series resistor per pole (the cutoff control: lower R ⇒ higher cutoff)
const CP = 1e-8; // shunt cap per pole (10 nF)
const RE = 22000; // emitter-follower tail resistor (bias current; ~mid-rail at the emitter)
const RB = 100000; // base bias divider legs (sets stage-1 base ≈ Vcc/2)

export const ladderBoard: SynthBoard = {
  id: 'ladder',
  name: 'Transistor Ladder Low-Pass',
  teaches:
    'a transistor low-pass filter: two emitter-follower–buffered RC poles in cascade roll off the highs at ~12 dB/oct. ' +
    'Each transistor buffers its pole so the next one sees a clean drive (why a ladder cascades stages). ' +
    'Turn the series resistors (Rp1/Rp2) to slide the cutoff — down opens it bright, up closes it dark.',
  build: () =>
    makeBoard(
      [
        // supplies (top-left rail, bottom-left signal)
        { id: 'VCC', kind: 'source', x: 6, y: 4, params: { wave: 'dc', amp: 9 } }, // +9 V rail
        { id: 'SIG', kind: 'source', x: 6, y: 80, params: { wave: 'guitar', amp: 1 } }, // input
        // input coupling + stage-1 base bias divider (centres the base near mid-rail)
        { id: 'Cin', kind: 'capacitor', x: 18, y: 70, params: { C: 1e-6 } },
        { id: 'Rb1', kind: 'resistor', x: 28, y: 18, params: { R: RB } }, // bias top (to Vcc)
        { id: 'Rb2', kind: 'resistor', x: 28, y: 48, params: { R: RB } }, // bias bottom (to gnd)
        // stage 1: emitter follower (collector→Vcc, base=biased input, emitter→Re1)
        { id: 'Q1', kind: 'bjt', x: 44, y: 28, params: { bjt: 'NPN' }, rot: 90 }, // collector up / base mid / emitter down
        { id: 'Re1', kind: 'resistor', x: 44, y: 60, params: { R: RE } }, // tail (emitter → gnd)
        // pole 1: series R from the emitter into a shunt cap to ground (cutoff = 1/(2πRp1·Cp1))
        { id: 'Rp1', kind: 'resistor', x: 58, y: 28, params: { R: RP } },
        { id: 'Cp1', kind: 'capacitor', x: 70, y: 55, params: { C: CP } },
        // stage 2: emitter follower, base DC-coupled to pole-1 out (which already sits near mid-rail)
        { id: 'Q2', kind: 'bjt', x: 84, y: 28, params: { bjt: 'NPN' }, rot: 90 },
        { id: 'Re2', kind: 'resistor', x: 84, y: 60, params: { R: RE } },
        // pole 2: second series R into shunt cap — the second buffered pole
        { id: 'Rp2', kind: 'resistor', x: 100, y: 28, params: { R: RP } },
        { id: 'Cp2', kind: 'capacitor', x: 112, y: 55, params: { C: CP } },
        { id: 'PRB', kind: 'probe', x: 130, y: 28 }, // scope/output at pole-2 out
      ],
      [
        // Vcc rail: VCC.hot — Rb1.a — Q1.c — Q2.c (both collectors to the rail)
        ['VCC', 'hot', 'Rb1', 'a'],
        ['VCC', 'hot', 'Q1', 'c'],
        ['VCC', 'hot', 'Q2', 'c'],
        // ground: VCC.gnd — SIG.gnd — Rb2.b — Re1.b — Cp1.b — Re2.b — Cp2.b
        ['VCC', 'gnd', 'SIG', 'gnd'],
        ['SIG', 'gnd', 'Rb2', 'b'],
        ['SIG', 'gnd', 'Re1', 'b'],
        ['SIG', 'gnd', 'Cp1', 'b'],
        ['SIG', 'gnd', 'Re2', 'b'],
        ['SIG', 'gnd', 'Cp2', 'b'],
        // input: SIG.hot — Cin.a; coupled to the stage-1 base
        ['SIG', 'hot', 'Cin', 'a'],
        // stage-1 base: Cin.b — Rb1.b — Rb2.a — Q1.b
        ['Cin', 'b', 'Q1', 'b'],
        ['Rb1', 'b', 'Q1', 'b'],
        ['Rb2', 'a', 'Q1', 'b'],
        // pole 1: Q1.e — Re1.a (tail) and Q1.e — Rp1.a — Cp1.a (series R into shunt cap)
        ['Q1', 'e', 'Re1', 'a'],
        ['Q1', 'e', 'Rp1', 'a'],
        ['Rp1', 'b', 'Cp1', 'a'],
        // stage-2 base DC-coupled to pole-1 out (Q1's emitter is ~mid-rail, so it self-biases Q2)
        ['Rp1', 'b', 'Q2', 'b'],
        // pole 2: Q2.e — Re2.a (tail) and Q2.e — Rp2.a — Cp2.a — probe
        ['Q2', 'e', 'Re2', 'a'],
        ['Q2', 'e', 'Rp2', 'a'],
        ['Rp2', 'b', 'Cp2', 'a'],
        ['Rp2', 'b', 'PRB', 'tip'],
      ],
    ),
};
