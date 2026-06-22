/**
 * Single home for the generalized engine's numeric constants (the §11 decisions; see
 * docs/ENGINE_DESIGN.md §8). Phase-0 device values + the pot-alpha guard are RE-EXPORTED (not
 * duplicated) so there is exactly one source for THERMAL_VOLTAGE / DIODE_MODELS / ALPHA_EPS.
 *
 * Import direction (no cycles): units.ts (leaf) <- constants.ts <- everything; diodeClipperCore -> units.
 */

export { THERMAL_VOLTAGE, DIODE_MODELS } from './diodeClipperCore';
export type { DiodeId, DiodeModel } from './diodeClipperCore';
export { ALPHA_EPS, clampPotAlpha } from '../units';

export const V_TOL = 1e-9; // Newton convergence: max node-voltage step (V)
export const DV_MAX = 0.3; // per-iteration node-voltage step limit (V) — Phase-0 verbatim, the damping
export const ARG_MAX = 60; // exp() argument backstop (Shockley) — Phase-0 verbatim
export const MAX_ITER = 50; // Newton iteration cap — flag, never spin
export const GMIN_COND = 1e-12; // always-on conditioning added to every node diagonal (well-posedness)
export const GMIN_FLOAT = 1e-7; // applied ONLY to an LU-flagged singular/floating node row, then re-factored
export const PIVOT_EPS = 1e-11; // |pivot| below this ⇒ singular row. Above GMIN_COND so a node carrying
// only GMIN_COND (a truly isolated/floating node) is caught, yet below the smallest legit conductance
// in play (a 1 GΩ feedback path is 1e-9 S ≫ 1e-11), so high-impedance circuits still solve.
export const RMIN = 1e-3; // a 0-Ω resistor/short ⇒ large-but-finite conductance (no Inf)
export const TRAP_SAFE = 1.0; // cap τ/dt ≥ this ⇒ trapezoidal companion, else backward-Euler
export const DEFAULT_VSAT = 9.0; // op-amp output rail (V), settable per part
export const NMAX = 32; // preallocated MNA system dimension cap (relatch re-allocs above this)
