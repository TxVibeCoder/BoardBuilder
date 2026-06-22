/**
 * Parametric component art contract (work order §6). Each component is a pure function
 * `(value) → SVG fragment + lead anchor points`, real-world sized in MILLIMETRES (the board renderer
 * scales mm → px). Appearance is computed from the component's value: resistor color bands from R,
 * electrolytic polarity stripe + size from C, diode cathode band, etc. No photos.
 *
 * Pin `name`s MUST match the netlist pin semantics, in the netlist pin order:
 *   resistor/capacitor/inductor → ['a','b'];  diode → ['a','k'] (anode, cathode);
 *   opamp → ['plus','minus','out'];  pot → ['a','wiper','b'];  source → ['hot','gnd'];  probe → ['tip'].
 */

import type { ComponentParams } from '../../engine/dsp/netlist';

export interface ArtPin {
  name: string;
  x: number; // mm, relative to the art bounding-box origin (top-left)
  y: number;
}

export interface ComponentArt {
  /** Inner SVG markup (paths/rects/circles/text), coordinates in mm. NO outer <svg> wrapper. */
  svg: string;
  width: number; // mm bounding box
  height: number; // mm
  pins: ArtPin[]; // lead/terminal anchors, in netlist pin order
}

export type ArtRenderer = (params: ComponentParams) => ComponentArt;
