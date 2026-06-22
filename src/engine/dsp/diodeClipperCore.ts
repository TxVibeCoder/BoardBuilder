/**
 * Diode-clipper nodal solver — pure DSP, no Web Audio types (work order §4, §9 circuit #4,
 * §10 Phase 0). This is the viability spike: it proves the solve→see→hear loop on the
 * simplest nonlinear circuit before any eyelet-board UI exists.
 *
 * CIRCUIT (one node):
 *
 *     vin ──[ Rseries ]──┬── vout
 *                        │
 *                       ╪╪   shunt diode(s) to ground
 *                        │      symmetric  = anti-parallel pair (two diodes)
 *                       gnd     asymmetric = one diode
 *
 * METHOD (the engine thesis, §4): Modified Nodal Analysis + Newton-Raphson. With one node
 * and one nonlinear element this is a scalar Newton solve, but it is the *real* method in
 * miniature — Phase 1 generalises the same conductance/Jacobian assembly to N nodes and adds
 * trapezoidal companion models for caps/inductors. WDF is a recorded rejection (see DECISIONS).
 *
 * The clipper is memoryless (no reactive parts yet), so there is no per-sample integration and
 * the sample rate does not enter the math — every sample is an independent operating-point
 * solve, warm-started from the previous sample for fast convergence.
 *
 * Diode model: Shockley I = Is·(exp(V/(n·Vt)) − 1). Device constants are nominal teaching
 * values — correct in *direction and rough magnitude* (§2 fidelity bar), not SPICE-grade.
 *
 * Units: volts in, volts out (vv == V here; see units.ts).
 */

import { clamp } from '../units';

export type DiodeId = 'Si' | 'Ge' | 'LED';

export interface DiodeModel {
  id: DiodeId;
  label: string;
  /** Saturation current Is (A). Larger ⇒ conducts sooner ⇒ lower, softer knee. */
  is: number;
  /** Emission/ideality factor n. */
  n: number;
  /** Nominal forward drop (V) — for display only. */
  vf: number;
}

/** Thermal voltage Vt = kT/q at ~300 K. */
export const THERMAL_VOLTAGE = 0.02585;

/**
 * Nominal teaching device models. The ordering Ge < Si < LED in forward drop is the lesson
 * (swap Si→LED ⇒ more headroom, harder edge); the exact Is/n are not manufacturer parts.
 */
export const DIODE_MODELS: Record<DiodeId, DiodeModel> = {
  Ge: { id: 'Ge', label: 'Germanium', is: 1.0e-6, n: 1.2, vf: 0.3 },
  Si: { id: 'Si', label: 'Silicon', is: 2.52e-9, n: 1.752, vf: 0.62 },
  LED: { id: 'LED', label: 'LED', is: 1.0e-19, n: 1.9, vf: 1.9 },
};

export const DIODE_ORDER: DiodeId[] = ['Si', 'Ge', 'LED'];

export interface ClipperConfig {
  /** Series resistance Rseries (Ω). */
  seriesR: number;
  /** Shunt diode device. */
  diode: DiodeId;
  /** true = anti-parallel pair (symmetric clip); false = single diode (asymmetric). */
  symmetric: boolean;
}

export const DEFAULT_CLIPPER_CONFIG: ClipperConfig = {
  seriesR: 4700,
  diode: 'Si',
  symmetric: true,
};

// --- Newton-Raphson tuning -------------------------------------------------------------------
const MAX_ITER = 100;
const V_TOL = 1e-9; // volts: converged when |Δv| < this
const DV_MAX = 0.3; // volts: per-iteration step limit (keeps Newton out of the deep-exp region)
const ARG_MAX = 60; // exp() argument backstop (exp(60) ≈ 1.1e26, finite) — DV_MAX keeps us far below
const GMIN = 1e-12; // S: tiny shunt conductance for a well-posed Jacobian at every node

export class DiodeClipperCore {
  private seriesG: number;
  private is: number;
  private vtEff: number;
  private symmetric: boolean;
  private vPrev = 0; // warm-start / continuation state

  /** Iterations used by the most recent processSample — diagnostics, set per sample (no alloc). */
  lastIterations = 0;

  constructor(config: Partial<ClipperConfig> = {}) {
    const c = { ...DEFAULT_CLIPPER_CONFIG, ...config };
    this.seriesG = 1 / Math.max(1, c.seriesR);
    const m = DIODE_MODELS[c.diode];
    this.is = m.is;
    this.vtEff = m.n * THERMAL_VOLTAGE;
    this.symmetric = c.symmetric;
  }

  setSeriesR(r: number): void {
    this.seriesG = 1 / Math.max(1, r);
  }

  setDiode(id: DiodeId): void {
    const m = DIODE_MODELS[id];
    this.is = m.is;
    this.vtEff = m.n * THERMAL_VOLTAGE;
  }

  setSymmetric(symmetric: boolean): void {
    this.symmetric = symmetric;
  }

  /** Drop the warm-start state (e.g. after a topology change). */
  reset(): void {
    this.vPrev = 0;
    this.lastIterations = 0;
  }

  /**
   * Solve the output-node voltage for one input sample.
   * KCL at vout:  (vin − vout)·G − Idiode(vout) = 0.
   * Returns vout in volts.
   */
  processSample(vin: number): number {
    const g = this.seriesG;
    const is = this.is;
    const vt = this.vtEff;
    const gOverVt = is / vt;

    let v = this.vPrev;
    let iter = 0;
    for (; iter < MAX_ITER; iter++) {
      const arg = clamp(v / vt, -ARG_MAX, ARG_MAX);
      let id: number;
      let gd: number;
      if (this.symmetric) {
        // anti-parallel pair: Id = Is·(e^arg − e^−arg) = 2·Is·sinh(arg); the ∓1 terms cancel.
        const ea = Math.exp(arg);
        const eb = Math.exp(-arg);
        id = is * (ea - eb);
        gd = gOverVt * (ea + eb);
      } else {
        const ea = Math.exp(arg);
        id = is * (ea - 1);
        gd = gOverVt * ea;
      }
      const f = g * (vin - v) - id; // residual
      const denom = g + gd + GMIN; // −f'(v); always > 0
      let dv = f / denom; // Newton step: v_new = v + dv
      if (dv > DV_MAX) dv = DV_MAX;
      else if (dv < -DV_MAX) dv = -DV_MAX;
      v += dv;
      if (dv > -V_TOL && dv < V_TOL) {
        iter++;
        break;
      }
    }
    this.vPrev = v;
    this.lastIterations = iter;
    return v;
  }
}

/** Map a diode index (worklet k-rate param) to its id, and back. */
export function diodeIdFromIndex(i: number): DiodeId {
  return DIODE_ORDER[clamp(Math.round(i), 0, DIODE_ORDER.length - 1)]!;
}

export function diodeIndexFromId(id: DiodeId): number {
  return DIODE_ORDER.indexOf(id);
}
