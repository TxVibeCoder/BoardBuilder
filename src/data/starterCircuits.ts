/**
 * The six loadable STARTER CIRCUITS (work order §9) — the learning on-ramp. Each is a
 * ready-to-run {@link Netlist} for `new CircuitCore(netlist)` plus the teaching copy
 * (what it teaches / a "turn this, hear this" prompt) and the 1–2 live knobs the demo
 * exposes as sliders. Listed in difficulty order: divider → low-pass → high-pass →
 * diode clipper → op-amp gain → op-amp soft-clip overdrive.
 *
 * Pure data only — no Web Audio, no DOM. Every circuit shares the conventions the engine
 * relies on: a ground eyelet 'gnd', a 'guitar'-wave source (so the live audio input drives
 * it; amp ≈ 0.3–2 V), and a 'probe' on the output node. Part values are picked for the
 * "direction + rough magnitude" fidelity bar: RC corners land in the low-kHz audio range
 * and the op-amp Rf/Rg gives ≈ ×11.
 */

import type { ComponentSpec, Netlist } from '../engine/dsp/netlist';

const FS = 48000;

/** A live slider the demo UI binds to a real component param (componentId+param must exist in the netlist). */
export interface StarterKnob {
  componentId: string;
  param: 'R' | 'C' | 'alpha' | 'amp';
  label: string;
  min: number;
  max: number;
}

export interface StarterCircuit {
  id: string;
  name: string;
  /** One-line "what it teaches". */
  teaches: string;
  /** The "turn this, hear this" prompt. */
  tryThis: string;
  /** 1–2 live knobs the demo exposes as sliders. */
  knobs: StarterKnob[];
  /** Ready for `new CircuitCore(netlist)`. */
  netlist: Netlist;
}

// --- netlist-builder helpers (mirror test/unit/circuitCore.test.ts) ------------------------------

function net(components: ComponentSpec[], extra: Partial<Netlist> = {}): Netlist {
  return { components, sampleRate: FS, groundEyelet: 'gnd', ...extra };
}
const R = (id: string, a: string, b: string, ohms: number): ComponentSpec => ({ id, kind: 'resistor', pins: [a, b], params: { R: ohms } });
const C = (id: string, a: string, b: string, farads: number): ComponentSpec => ({ id, kind: 'capacitor', pins: [a, b], params: { C: farads } });
const D = (id: string, a: string, k: string, symmetric: boolean): ComponentSpec => ({ id, kind: 'diode', pins: [a, k], params: { diode: 'Si', symmetric } });
const opamp = (id: string, plus: string, minus: string, out: string, vsat = 9): ComponentSpec => ({ id, kind: 'opamp', pins: [plus, minus, out], params: { vsat } });
const probe = (n: string): ComponentSpec => ({ id: 'PROBE', kind: 'probe', pins: [n], params: {} });
const guitarSrc = (id: string, hot: string, gnd: string, amp = 1): ComponentSpec => ({ id, kind: 'source', pins: [hot, gnd], params: { wave: 'guitar', amp, rsrc: 1e-6 } });

// --- the six -------------------------------------------------------------------------------------

export const STARTER_CIRCUITS: StarterCircuit[] = [
  // §9.1 — voltage divider
  {
    id: 'divider',
    name: 'Voltage Divider',
    teaches: 'two resistors split a voltage: V_out = V_in · R2/(R1+R2)',
    tryThis: 'turn R2 up → hear the output get louder (a bigger slice of the signal)',
    knobs: [{ componentId: 'R2', param: 'R', label: 'R2 (bottom leg)', min: 100, max: 100000 }],
    netlist: net([
      guitarSrc('S', 'n1', 'gnd', 1),
      R('R1', 'n1', 'n2', 1000),
      R('R2', 'n2', 'gnd', 3000),
      probe('n2'),
    ]),
  },

  // §9.2 — RC low-pass (tone roll-off)
  {
    id: 'rc-lowpass',
    name: 'RC Low-Pass (tone control)',
    teaches: 'caps shunt highs to ground; cutoff ≈ 1/(2πRC)',
    tryThis: 'turn R up → hear the top end darken (the cutoff slides down)',
    // R = 1591.55 Ω, C = 100 nF ⇒ fc ≈ 1000 Hz; sliding R 159..15915 Ω moves fc ~10 kHz..100 Hz.
    knobs: [{ componentId: 'R', param: 'R', label: 'R (sets cutoff)', min: 159, max: 15915 }],
    netlist: net([
      guitarSrc('S', 'n1', 'gnd', 1),
      R('R', 'n1', 'n2', 1591.55),
      C('C', 'n2', 'gnd', 1e-7),
      probe('n2'),
    ]),
  },

  // §9.3 — RC high-pass (coupling / bass cut)
  {
    id: 'rc-highpass',
    name: 'RC High-Pass (coupling cap)',
    teaches: 'a series cap blocks DC and lows, passes highs; cutoff ≈ 1/(2πRC)',
    tryThis: 'turn R down → hear the bass thin out (the cutoff climbs up into the mids)',
    // C = 100 nF, R = 1591.55 Ω ⇒ fc ≈ 1000 Hz; sliding R 159..15915 Ω moves fc ~10 kHz..100 Hz.
    knobs: [{ componentId: 'R', param: 'R', label: 'R (sets cutoff)', min: 159, max: 15915 }],
    netlist: net([
      guitarSrc('S', 'n1', 'gnd', 1),
      C('C', 'n1', 'n2', 1e-7),
      R('R', 'n2', 'gnd', 1591.55),
      probe('n2'),
    ]),
  },

  // §9.4 — diode clipper (symmetric; single-diode note in `teaches`)
  {
    id: 'diode-clipper',
    name: 'Diode Clipper (fuzz)',
    teaches: 'diodes to ground clamp the signal near their forward drop (~0.6 V for silicon), squaring it off — a symmetric pair clips both halves; a single diode clips only one half (asymmetric)',
    tryThis: 'turn the series R down → hear it clip harder and dirtier (more current is forced into the diodes)',
    // R = 4700 Ω series; symmetric Si pair to ground clamps ≈ ±0.6 V. Drive amp ≈ 2 V to clip well.
    knobs: [{ componentId: 'R', param: 'R', label: 'series R (drive)', min: 220, max: 47000 }],
    netlist: net([
      guitarSrc('S', 'n1', 'gnd', 2),
      R('R', 'n1', 'n2', 4700),
      D('D', 'n2', 'gnd', true),
      probe('n2'),
    ]),
  },

  // §9.5 — non-inverting op-amp gain stage (gain = 1 + Rf/Rg)
  {
    id: 'opamp-gain',
    name: 'Op-Amp Gain Stage',
    teaches: 'a non-inverting op-amp boosts by 1 + Rf/Rg, clamped to the supply rails',
    tryThis: 'turn Rf up → hear it get louder, then hit the rails and clip (gain = 1 + Rf/Rg)',
    // Rf = 100 kΩ, Rg = 10 kΩ ⇒ gain ≈ ×11. Drive amp ≈ 0.3 V stays clean below the ±9 V rails.
    knobs: [{ componentId: 'Rf', param: 'R', label: 'Rf (feedback / gain)', min: 0, max: 470000 }],
    netlist: net([
      guitarSrc('S', 'in', 'gnd', 0.3),
      opamp('U', 'in', 'm', 'out'),
      R('Rf', 'out', 'm', 100000),
      R('Rg', 'm', 'gnd', 10000),
      probe('out'),
    ]),
  },

  // §9.6 — op-amp soft-clip overdrive (anti-parallel diodes across Rf)
  {
    id: 'opamp-overdrive',
    name: 'Op-Amp Soft-Clip Overdrive',
    teaches: 'anti-parallel diodes across the feedback resistor soften the gain as the signal grows — a smooth, compressing overdrive instead of a hard clip',
    tryThis: 'turn Rf up → hear it push into the diodes sooner: gritty, compressed overdrive (the gain folds back before the rails)',
    // Rf = 100 kΩ, Rg = 10 kΩ ⇒ small-signal gain ≈ ×11; symmetric Si pair across Rf soft-clips first.
    knobs: [{ componentId: 'Rf', param: 'R', label: 'Rf (drive)', min: 10000, max: 470000 }],
    netlist: net([
      guitarSrc('S', 'in', 'gnd', 0.5),
      opamp('U', 'in', 'm', 'out'),
      R('Rf', 'out', 'm', 100000),
      R('Rg', 'm', 'gnd', 10000),
      D('Dclip', 'out', 'm', true),
      probe('out'),
    ]),
  },
];
