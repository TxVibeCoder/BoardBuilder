/**
 * Premade circuits as ready-to-load BOARDS (not just engine netlists): real placed components plus
 * jumper wires, so loading one drops a complete, legible, tweakable circuit onto the Build canvas.
 * Every connection is an explicit jumper (a logical edge → `compileNetlist` unions the eyelets), so the
 * layout is purely for legibility — parts are spread in signal-flow order and never overlap. The
 * electrical result is verified by the premade audio battery (test/unit/premadeBoards.test.ts).
 *
 * Pure data — no Web Audio, no DOM. Loaded via Board's "Load a circuit" menu; `toNetlist(board)` then
 * derives the engine netlist exactly as for a hand-built board.
 */

import { COMPONENT_ART } from './componentArt';
import { defaultParams, type BoardComponent, type BoardState, type PinRef } from './boardModel';
import type { ComponentKind, ComponentParams } from '../../engine/dsp/netlist';
import { vcoBoard } from './synth/vcoBoard';
import { ladderBoard } from './synth/ladderBoard';
import * as adsr from './synth/adsrBoard';

interface PartSpec {
  id: string;
  kind: ComponentKind;
  x: number;
  y: number;
  rot?: number;
  params?: ComponentParams;
}
/** A wire: [componentA, pinNameA, componentB, pinNameB] — connects two legs by their art pin names. */
type WireSpec = [string, string, string, string];

export interface PremadeCircuit {
  id: string;
  name: string;
  teaches: string;
  /** Menu grouping label (e.g. 'Pedals & EQ' vs 'Synth'); defaults to the pedal group when unset. */
  group?: string;
  build: () => BoardState;
}

const FS = 48000;

/** Resolve an art pin name → its netlist pin index for a given kind+params. */
function pinIndexByName(kind: ComponentKind, params: ComponentParams, name: string): number {
  const art = COMPONENT_ART[kind]?.(params);
  const idx = art ? art.pins.findIndex((p) => p.name === name) : -1;
  if (idx < 0) throw new Error(`premade: ${kind} has no pin '${name}'`);
  return idx;
}

/** Build a BoardState from placed parts + named-pin wires (each wire becomes a jumper component). */
function makeBoard(parts: PartSpec[], wires: WireSpec[]): BoardState {
  const components: BoardComponent[] = parts.map((p) => ({
    id: p.id,
    kind: p.kind,
    params: { ...defaultParams(p.kind), ...(p.params ?? {}) },
    x: p.x,
    y: p.y,
    rot: p.rot,
  }));
  const byId = new Map(components.map((c) => [c.id, c]));
  const ref = (compId: string, pinName: string): PinRef => {
    const c = byId.get(compId);
    if (!c) throw new Error(`premade: no component '${compId}'`);
    return { componentId: compId, pinIndex: pinIndexByName(c.kind, c.params, pinName) };
  };
  wires.forEach((w, i) => {
    components.push({ id: `W${i + 1}`, kind: 'jumper', params: {}, x: 0, y: 0, link: { a: ref(w[0], w[1]), b: ref(w[2], w[3]) } });
  });
  return { components, sampleRate: FS, nextId: 200 };
}

export const PREMADE_CIRCUITS: PremadeCircuit[] = [
  // 1) Voltage divider — the "one resistor does nothing, a divider does" lesson, prebuilt.
  {
    id: 'divider',
    name: 'Voltage Divider',
    teaches: 'two resistors split the signal: V_out = V_in · R2/(R1+R2). Turn either R and hear the level move.',
    build: () =>
      makeBoard(
        [
          { id: 'SRC', kind: 'source', x: 12, y: 38, params: { wave: 'guitar', amp: 1 } },
          { id: 'R1', kind: 'resistor', x: 44, y: 26, params: { R: 10000 } },
          { id: 'R2', kind: 'resistor', x: 44, y: 56, params: { R: 10000 } },
          { id: 'PRB', kind: 'probe', x: 120, y: 36 },
        ],
        [
          ['SRC', 'hot', 'R1', 'a'], // vin
          ['R1', 'b', 'R2', 'a'], // mid
          ['R1', 'b', 'PRB', 'tip'], // probe the mid node
          ['R2', 'b', 'SRC', 'gnd'], // ground return
        ],
      ),
  },

  // 2) RC low-pass tone control — R then a shunt cap to ground; cutoff ≈ 1/(2πRC).
  {
    id: 'rc-lowpass',
    name: 'RC Low-Pass (tone)',
    teaches: 'a series R into a cap-to-ground rolls off highs; cutoff ≈ 1/(2πRC). Turn R to slide the tone darker/brighter.',
    build: () =>
      makeBoard(
        [
          { id: 'SRC', kind: 'source', x: 12, y: 38, params: { wave: 'guitar', amp: 1 } },
          { id: 'R', kind: 'resistor', x: 44, y: 30, params: { R: 1591.55 } }, // fc ≈ 1 kHz with 100 nF
          { id: 'C', kind: 'capacitor', x: 80, y: 50, params: { C: 1e-7 } },
          { id: 'PRB', kind: 'probe', x: 120, y: 34 },
        ],
        [
          ['SRC', 'hot', 'R', 'a'], // vin
          ['R', 'b', 'C', 'a'], // out
          ['R', 'b', 'PRB', 'tip'],
          ['C', 'b', 'SRC', 'gnd'], // shunt to ground
        ],
      ),
  },

  // 3) Diode clipper (fuzz) — series R into anti-parallel diodes to ground; clamps ≈ ±0.6 V.
  {
    id: 'diode-clipper',
    name: 'Diode Clipper (fuzz)',
    teaches: 'diodes to ground clamp the signal near ±0.6 V, squaring it into fuzz. Turn the series R down to clip harder.',
    build: () =>
      makeBoard(
        [
          { id: 'SRC', kind: 'source', x: 12, y: 38, params: { wave: 'guitar', amp: 2 } },
          { id: 'R', kind: 'resistor', x: 44, y: 30, params: { R: 4700 } },
          { id: 'D', kind: 'diode', x: 80, y: 52, params: { diode: 'Si', symmetric: true } },
          { id: 'PRB', kind: 'probe', x: 120, y: 34 },
        ],
        [
          ['SRC', 'hot', 'R', 'a'], // vin
          ['R', 'b', 'D', 'a'], // out (anode)
          ['R', 'b', 'PRB', 'tip'],
          ['D', 'k', 'SRC', 'gnd'], // cathode to ground
        ],
      ),
  },

  // 4) Transistor boost — NPN common-emitter, Vcc rail + base divider, Rc/Re; gain ≈ Rc/Re ≈ 4.7×.
  {
    id: 'bjt-boost',
    name: 'Transistor Boost (NPN)',
    teaches: 'a common-emitter transistor stage amplifies: a Vcc rail biases it, gain ≈ Rc/Re, and pushed hard it clips. The base divider sets the operating point.',
    build: () =>
      makeBoard(
        [
          { id: 'VCC', kind: 'source', x: 6, y: 6, params: { wave: 'dc', amp: 9 } }, // supply rail (top-left)
          { id: 'SIG', kind: 'source', x: 6, y: 58, params: { wave: 'guitar', amp: 1 } }, // input signal (bottom-left)
          { id: 'Cin', kind: 'capacitor', x: 34, y: 56, params: { C: 1e-6 } }, // input coupling
          { id: 'R1', kind: 'resistor', x: 56, y: 22, params: { R: 47000 } }, // bias top (above the base)
          { id: 'R2', kind: 'resistor', x: 56, y: 70, params: { R: 10000 } }, // bias bottom (below the base)
          { id: 'Rc', kind: 'resistor', x: 82, y: 10, params: { R: 4700 }, rot: 90 }, // collector load (vertical, up to Vcc)
          { id: 'Re', kind: 'resistor', x: 82, y: 64, params: { R: 1000 }, rot: 90 }, // emitter degeneration (vertical, down to gnd)
          { id: 'Q', kind: 'bjt', x: 92, y: 40, params: { bjt: 'NPN' }, rot: 90 }, // rotated ⇒ collector up / base mid / emitter down
          { id: 'Cout', kind: 'capacitor', x: 110, y: 36, params: { C: 1e-7 } }, // output coupling (blocks DC bias; ~16 Hz corner)
          { id: 'Rload', kind: 'resistor', x: 120, y: 62, params: { R: 100000 } }, // output load (DC path for Cout)
          { id: 'PRB', kind: 'probe', x: 148, y: 38 },
        ],
        [
          // Vcc rail: VCC.hot — R1.a — Rc.a
          ['VCC', 'hot', 'R1', 'a'],
          ['VCC', 'hot', 'Rc', 'a'],
          // ground: VCC.gnd — SIG.gnd — R2.b — Re.b — Rload.b
          ['VCC', 'gnd', 'SIG', 'gnd'],
          ['SIG', 'gnd', 'R2', 'b'],
          ['SIG', 'gnd', 'Re', 'b'],
          ['SIG', 'gnd', 'Rload', 'b'],
          // input: SIG.hot — Cin.a
          ['SIG', 'hot', 'Cin', 'a'],
          // base: Cin.b — R1.b — R2.a — Q.b
          ['Cin', 'b', 'Q', 'b'],
          ['R1', 'b', 'Q', 'b'],
          ['R2', 'a', 'Q', 'b'],
          // collector: Rc.b — Q.c — Cout.a
          ['Rc', 'b', 'Q', 'c'],
          ['Q', 'c', 'Cout', 'a'],
          // AC-coupled output: Cout.b — Rload.a — probe
          ['Cout', 'b', 'Rload', 'a'],
          ['Cout', 'b', 'PRB', 'tip'],
          // emitter: Q.e — Re.a
          ['Q', 'e', 'Re', 'a'],
        ],
      ),
  },

  // --- Synth track (transistor-based: oscillator, filter, envelope/VCA) -----------------------------
  { ...vcoBoard, group: 'Synth' },
  { ...ladderBoard, group: 'Synth' },
  { id: adsr.id, name: adsr.name, teaches: adsr.teaches, build: adsr.build, group: 'Synth' },
];
