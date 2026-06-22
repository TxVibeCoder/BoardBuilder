/**
 * Component-art registry: maps a netlist {@link ComponentKind} to its parametric SVG renderer. The
 * board uses this both to DRAW each part and to know where its lead/terminal pins land (the pins are
 * returned in netlist order, so pin index ↔ netlist pin). Inductor/jumper have no dedicated art yet.
 */

import type { ComponentKind } from '../../engine/dsp/netlist';
import type { ArtRenderer } from './artTypes';
import { capacitorArt, diodeArt, resistorArt } from './art/passives';
import { opampArt, potArt, probeArt, sourceArt } from './art/active';

export const COMPONENT_ART: Partial<Record<ComponentKind, ArtRenderer>> = {
  resistor: resistorArt,
  capacitor: capacitorArt,
  diode: diodeArt,
  opamp: opampArt,
  pot: potArt,
  source: sourceArt,
  probe: probeArt,
};

export function artFor(kind: ComponentKind): ArtRenderer | undefined {
  return COMPONENT_ART[kind];
}
