/**
 * Component stamp API + the per-kind stampers (engine spec §2). Each component implements `Stamper`
 * with two phases: a LINEAR stamp (constant on topology/dt/knob → static G0/RHS0) and, for nonlinear
 * parts (diode, op-amp rails), a NONLINEAR stamp re-evaluated each Newton iteration at the current
 * guess. Reactive parts (cap/inductor) carry a linear companion conductance + a per-sample RHS current.
 *
 * Solve convention (reproduces Phase-0 exactly — engine spec §2): we assemble the companion-linearized
 * system A·v_next = b and solve for the NEXT iterate; a linear circuit converges in one solve. `b` is
 * the injected-current RHS; a nonlinear device contributes conductance `gd` to A and companion current
 * `ieq = id − gd·vd` to `b`.
 */

import { clamp, clampPotAlpha } from '../units';
import { ARG_MAX, BJT_NPN, DEFAULT_VSAT, DIODE_MODELS, RMIN, THERMAL_VOLTAGE, TRAP_SAFE, type DiodeId } from './constants';
import { isStructural, type CompiledNetlist, type ComponentSpec, type Netlist } from './netlist';

// Op-amp open-loop gain for the saturating finite-gain model (below). Large enough that closed-loop
// gain = 1+Rf/Rg holds to ~1/A (≈0.001%), small enough to stay Newton-friendly.
const OPAMP_GAIN = 1e5;

/** Voltage at a matrix node index (ground = -1 ⇒ 0 V). */
function nodeV(v: Float64Array, i: number): number {
  return i >= 0 ? v[i]! : 0;
}

/**
 * Reused, mutable stamp scratchpad. mnaSystem owns ONE of these and repoints its fields each sample
 * (no per-sample allocation). The add* primitives are ground-safe (index < 0 == ground, skipped) and
 * index with the matrix's fixed `stride` (= solver capacity), not `n`.
 */
export class StampContext {
  A: Float64Array = new Float64Array(0);
  b: Float64Array = new Float64Array(0);
  v: Float64Array = new Float64Array(0);
  stride = 0;
  n = 0;
  nodeCount = 0;
  dt = 0;
  time = 0;
  extIn = 0;

  /** Symmetric conductance between i and j (the 4-entry resistor pattern). */
  addG(i: number, j: number, g: number): void {
    const A = this.A;
    const s = this.stride;
    if (i >= 0) A[i * s + i] = A[i * s + i]! + g;
    if (j >= 0) A[j * s + j] = A[j * s + j]! + g;
    if (i >= 0 && j >= 0) {
      A[i * s + j] = A[i * s + j]! - g;
      A[j * s + i] = A[j * s + i]! - g;
    }
  }

  /** Current source pushing `cur` from i to j: inject +cur at i, −cur at j. */
  addI(i: number, j: number, cur: number): void {
    const b = this.b;
    if (i >= 0) b[i] = b[i]! + cur;
    if (j >= 0) b[j] = b[j]! - cur;
  }

  /** Inject `val` into RHS row i. */
  addB(i: number, val: number): void {
    if (i >= 0) this.b[i] = this.b[i]! + val;
  }

  /** Asymmetric single-entry stamp A[i][j] += val (nullor incidence / ideal-source rows). */
  addA(i: number, j: number, val: number): void {
    if (i >= 0 && j >= 0) this.A[i * this.stride + j] = this.A[i * this.stride + j]! + val;
  }
}

export interface Stamper {
  readonly id: string;
  readonly nonlinear: boolean;
  readonly reactive: boolean;
  readonly auxRows: number;
  readonly nodes: number[]; // resolved pin matrix indices (-1 = ground)
  /** Reactive parts only: choose companion method + conductance from the local stiffness. */
  prepare?(dt: number, gLocal: number): void;
  stampLinear(ctx: StampContext): void;
  loadDynamic?(ctx: StampContext): void;
  stampNonlinear?(ctx: StampContext): void;
  commitSample(ctx: StampContext): void;
  reset(): void;
}

class ResistorStamper implements Stamper {
  readonly nonlinear = false;
  readonly reactive = false;
  readonly auxRows = 0;
  constructor(readonly id: string, readonly nodes: number[], private readonly spec: ComponentSpec) {}
  stampLinear(ctx: StampContext): void {
    const g = 1 / Math.max(this.spec.params.R ?? 1000, RMIN);
    ctx.addG(this.nodes[0]!, this.nodes[1]!, g);
  }
  commitSample(): void {}
  reset(): void {}
}

/** Norton source: Vs in series with Rsrc (small ⇒ ≈ideal). Conductance is linear; value is per-sample. */
class SourceStamper implements Stamper {
  readonly nonlinear = false;
  readonly reactive = false;
  readonly auxRows = 0;
  // Free-running phase (not absolute time × freq): a frequency knob turn keeps the accumulated phase
  // and only changes the increment, so the sine stays continuous across the change (no click).
  private phase = 0;
  constructor(readonly id: string, readonly nodes: number[], private readonly spec: ComponentSpec) {}
  private g(): number {
    // Floor Rsrc at 1 mΩ: ideal enough that the source sets its node to ~Vs (divider/subsumption hold),
    // but not so tiny it ill-conditions a high-impedance circuit (a 10 MΩ divider would otherwise span
    // ~1e18 in the matrix). `ideal:true` degrades to this near-ideal Norton model.
    return 1 / Math.max(this.spec.params.rsrc ?? 1e-3, 1e-3);
  }
  stampLinear(ctx: StampContext): void {
    ctx.addG(this.nodes[0]!, this.nodes[1]!, this.g());
  }
  loadDynamic(ctx: StampContext): void {
    const p = this.spec.params;
    const wave = p.wave ?? 'sine';
    // 'guitar' tracks the live input; 'dc' is a constant supply rail (Vcc); else a free-running sine.
    let vs: number;
    if (wave === 'guitar') vs = ctx.extIn * (p.amp ?? 1);
    else if (wave === 'dc') vs = p.amp ?? 1;
    else vs = (p.amp ?? 1) * Math.sin(this.phase);
    ctx.addI(this.nodes[0]!, this.nodes[1]!, vs * this.g());
    if (wave === 'sine') {
      const twoPi = 2 * Math.PI;
      this.phase += twoPi * (p.freq ?? 1000) * ctx.dt;
      if (this.phase >= twoPi) this.phase %= twoPi;
    }
  }
  commitSample(): void {}
  reset(): void {
    this.phase = 0;
  }
}

/**
 * Capacitor or inductor companion model (engine spec §5). Backward-Euler by default; trapezoidal only
 * when the local time constant is comfortably in-band (τ/dt ≥ TRAP_SAFE) so TR can never ring on a
 * stiff RC. `prepare` runs at topology/knob time (not per sample); `loadDynamic` refreshes the history
 * current each sample; `commitSample` advances state.
 */
class ReactiveStamper implements Stamper {
  readonly nonlinear = false;
  readonly reactive = true;
  readonly auxRows = 0;
  private prevV = 0;
  private prevI = 0;
  private Geq = 0;
  private ieq = 0;
  private trap = false;
  private latched = false; // the BE/TR choice is picked ONCE per topology, then held
  constructor(
    readonly id: string,
    readonly nodes: number[],
    private readonly spec: ComponentSpec,
    private readonly isCap: boolean,
  ) {}

  prepare(dt: number, gLocal: number): void {
    const g = Math.max(gLocal, 1e-15);
    // Pick the companion method ONCE per topology (latched). Two reasons: (1) a knob turn re-runs this
    // and must NOT flip BE↔TR mid-stream (a step discontinuity); (2) it requires a real resistive
    // damping path before allowing trapezoidal — an undamped / reactive-only node (gLocal≈0, e.g. a
    // node between two series caps) MUST use backward-Euler, because trapezoidal rings without damping.
    if (this.isCap) {
      const C = this.spec.params.C ?? 1e-9;
      if (!this.latched) {
        this.trap = gLocal > 1e-9 && C / g / dt >= TRAP_SAFE;
        this.latched = true;
      }
      this.Geq = this.trap ? (2 * C) / dt : C / dt;
    } else {
      const L = this.spec.params.L ?? 1e-3;
      if (!this.latched) {
        this.trap = gLocal > 1e-9 && L * g / dt >= TRAP_SAFE; // τ_L = L·gLocal
        this.latched = true;
      }
      this.Geq = this.trap ? dt / (2 * L) : dt / L;
    }
  }

  stampLinear(ctx: StampContext): void {
    ctx.addG(this.nodes[0]!, this.nodes[1]!, this.Geq);
  }

  loadDynamic(ctx: StampContext): void {
    if (this.isCap) {
      this.ieq = this.trap ? this.Geq * this.prevV + this.prevI : this.Geq * this.prevV;
    } else {
      this.ieq = this.trap ? -(this.prevI + this.Geq * this.prevV) : -this.prevI;
    }
    ctx.addI(this.nodes[0]!, this.nodes[1]!, this.ieq);
  }

  commitSample(ctx: StampContext): void {
    const vAB = nodeV(ctx.v, this.nodes[0]!) - nodeV(ctx.v, this.nodes[1]!);
    this.prevI = this.Geq * vAB - this.ieq;
    this.prevV = vAB;
  }

  reset(): void {
    this.prevV = 0;
    this.prevI = 0;
    this.ieq = 0;
    this.latched = false; // re-pick the companion method on the next topology assembly
  }
}

/** Shockley diode (Phase-0 math, node-to-node). Nonlinear: stamps gd + companion current each iter. */
class DiodeStamper implements Stamper {
  readonly nonlinear = true;
  readonly reactive = false;
  readonly auxRows = 0;
  private is = DIODE_MODELS.Si.is;
  private vtEff = DIODE_MODELS.Si.n * THERMAL_VOLTAGE;
  private cachedId: DiodeId | '' = '';
  constructor(readonly id: string, readonly nodes: number[], private readonly spec: ComponentSpec) {}
  private sync(): void {
    const d = this.spec.params.diode ?? 'Si';
    if (d !== this.cachedId) {
      const m = DIODE_MODELS[d];
      this.is = m.is;
      this.vtEff = m.n * THERMAL_VOLTAGE;
      this.cachedId = d;
    }
  }
  stampLinear(): void {}
  stampNonlinear(ctx: StampContext): void {
    this.sync();
    const a = this.nodes[0]!;
    const k = this.nodes[1]!;
    const vd = nodeV(ctx.v, a) - nodeV(ctx.v, k);
    const arg = clamp(vd / this.vtEff, -ARG_MAX, ARG_MAX);
    const ea = Math.exp(arg);
    let id: number;
    let gd: number;
    if (this.spec.params.symmetric ?? true) {
      const eb = Math.exp(-arg);
      id = this.is * (ea - eb);
      gd = (this.is / this.vtEff) * (ea + eb);
    } else {
      id = this.is * (ea - 1);
      gd = (this.is / this.vtEff) * ea;
    }
    const ieq = id - gd * vd;
    ctx.addG(a, k, gd);
    ctx.addI(a, k, -ieq);
  }
  commitSample(): void {}
  reset(): void {}
}

/**
 * Op-amp as a finite-gain SATURATING source (engine spec §2, revised): the output is a controlled
 * source `out = Vsat·tanh(A·(v+ − v−)/Vsat)` with a large open-loop gain A and one aux current
 * unknown `Io` at row `k`. In the linear region this pins v+ ≈ v− to ~1/A, so closed-loop gain is
 * exactly 1+Rf/Rg; past the rail the tanh bounds the output at ±Vsat (and the bound propagates
 * downstream + arrests integrators). Input pins draw zero current (infinite Zin). Nonlinear → it
 * participates in Newton.
 *
 * Why not a pure nullor + rail-clamp diodes: a nullor sources unbounded output current, so clamp
 * diodes to ±Vsat can't actually bound it — saturation means leaving the v+=v− regime, which only a
 * finite-gain model can represent.
 */
class OpAmpStamper implements Stamper {
  readonly nonlinear = true;
  readonly reactive = false;
  readonly auxRows = 1;
  constructor(
    readonly id: string,
    readonly nodes: number[], // [plus, minus, out]
    private readonly aux: number,
    private readonly spec: ComponentSpec,
  ) {}

  stampLinear(ctx: StampContext): void {
    const out = this.nodes[2]!;
    const k = this.aux;
    ctx.addA(out, k, 1); // KCL at out: + output current Io
    ctx.addA(k, out, 1); // constraint row: v[out] − f(v+−v−) = 0  (the v[out] term is linear)
  }

  stampNonlinear(ctx: StampContext): void {
    const plus = this.nodes[0]!;
    const minus = this.nodes[1]!;
    const k = this.aux;
    const vsat = this.spec.params.vsat ?? DEFAULT_VSAT;
    const vd = nodeV(ctx.v, plus) - nodeV(ctx.v, minus);
    const t = Math.tanh((OPAMP_GAIN * vd) / vsat);
    const f = vsat * t;
    const fp = OPAMP_GAIN * (1 - t * t); // df/dvd
    // linearize v[out] − f(vd) = 0 → v[out] − fp·v+ + fp·v− = f − fp·vd
    ctx.addA(k, plus, -fp);
    ctx.addA(k, minus, fp);
    ctx.addB(k, f - fp * vd);
  }

  commitSample(): void {}
  reset(): void {}
}

/** Potentiometer: two resistor legs a↔wiper and wiper↔b split by the (clamped) wiper position. */
class PotStamper implements Stamper {
  readonly nonlinear = false;
  readonly reactive = false;
  readonly auxRows = 0;
  constructor(readonly id: string, readonly nodes: number[], private readonly spec: ComponentSpec) {}
  stampLinear(ctx: StampContext): void {
    const a = this.nodes[0]!;
    const w = this.nodes[1]!;
    const b = this.nodes[2]!;
    const alpha = clampPotAlpha(this.spec.params.alpha ?? 0.5);
    const potR = Math.max(this.spec.params.potR ?? 10000, RMIN);
    ctx.addG(a, w, 1 / (alpha * potR));
    ctx.addG(w, b, 1 / ((1 - alpha) * potR));
  }
  commitSample(): void {}
  reset(): void {}
}

/**
 * Bipolar junction transistor — Ebers-Moll (transport form), NPN. Three terminals [c, b, e]; two
 * coupled diode junctions (base-emitter, base-collector) plus the current-gain coupling, so it is the
 * same Newton machinery as the diode, generalized to a 3×3 companion stamp. In forward-active
 * (Vbe ≳ 0.6 V, Vbc < 0) it gives Ic ≈ Is·e^(Vbe/Vt) and Ib ≈ Ic/βF — i.e. current gain βF — which is
 * what makes a common-emitter stage amplify. Currents are defined flowing INTO each terminal; the
 * emitter row is the negative sum (KCL closes inside the device). Teaching model, not SPICE-grade.
 */
class BjtStamper implements Stamper {
  readonly nonlinear = true;
  readonly reactive = false;
  readonly auxRows = 0;
  private readonly is = BJT_NPN.is;
  private readonly betaF = BJT_NPN.betaF;
  private readonly betaR = BJT_NPN.betaR;
  private readonly vt = THERMAL_VOLTAGE;
  constructor(readonly id: string, readonly nodes: number[]) {} // [c, b, e]
  stampLinear(): void {}
  stampNonlinear(ctx: StampContext): void {
    const nc = this.nodes[0]!;
    const nb = this.nodes[1]!;
    const ne = this.nodes[2]!;
    const vt = this.vt;
    const vbe = nodeV(ctx.v, nb) - nodeV(ctx.v, ne);
    const vbc = nodeV(ctx.v, nb) - nodeV(ctx.v, nc);
    const f = Math.exp(clamp(vbe / vt, -ARG_MAX, ARG_MAX));
    const r = Math.exp(clamp(vbc / vt, -ARG_MAX, ARG_MAX));
    const gf = (this.is * f) / vt; // d(Is·e^Vbe)/dVbe
    const gr = (this.is * r) / vt; // d(Is·e^Vbc)/dVbc
    const grc = gr * (1 + 1 / this.betaR);

    // terminal currents into the device
    const ic = this.is * (f - r) - (this.is * (r - 1)) / this.betaR;
    const ib = (this.is * (f - 1)) / this.betaF + (this.is * (r - 1)) / this.betaR;
    const I = [ic, ib, -(ic + ib)];

    // Jacobian g[t][j] = dI_t/dV_j, j index 0=c,1=b,2=e (via Vbe=Vb−Ve, Vbc=Vb−Vc)
    const dIc = [grc, gf - grc, -gf];
    const dIb = [-gr / this.betaR, gf / this.betaF + gr / this.betaR, -gf / this.betaF];
    const g = [dIc, dIb, [-(dIc[0]! + dIb[0]!), -(dIc[1]! + dIb[1]!), -(dIc[2]! + dIb[2]!)]];

    // companion stamp: A[n_t][n_j] += g[t][j]; b[n_t] += Σ_j g[t][j]·V_j0 − I_t  (ground cols drop out)
    for (let t = 0; t < 3; t++) {
      const nt = this.nodes[t]!;
      if (nt < 0) continue;
      let comp = 0;
      for (let j = 0; j < 3; j++) {
        ctx.addA(nt, this.nodes[j]!, g[t]![j]!);
        comp += g[t]![j]! * nodeV(ctx.v, this.nodes[j]!);
      }
      ctx.addB(nt, comp - I[t]!);
    }
  }
  commitSample(): void {}
  reset(): void {}
}

/** Build the stamper objects for a compiled netlist (structural parts — jumper/probe — contribute none). */
export function buildStampers(net: Netlist, compiled: CompiledNetlist): Stamper[] {
  const out: Stamper[] = [];
  net.components.forEach((c, i) => {
    if (isStructural(c.kind)) return;
    const nodes = compiled.pinNodes[i]!;
    switch (c.kind) {
      case 'resistor':
        out.push(new ResistorStamper(c.id, nodes, c));
        break;
      case 'source':
        out.push(new SourceStamper(c.id, nodes, c));
        break;
      case 'capacitor':
        out.push(new ReactiveStamper(c.id, nodes, c, true));
        break;
      case 'inductor':
        out.push(new ReactiveStamper(c.id, nodes, c, false));
        break;
      case 'diode':
        out.push(new DiodeStamper(c.id, nodes, c));
        break;
      case 'opamp':
        out.push(new OpAmpStamper(c.id, nodes, compiled.auxBase[i]!, c));
        break;
      case 'pot':
        out.push(new PotStamper(c.id, nodes, c));
        break;
      case 'bjt':
        out.push(new BjtStamper(c.id, nodes));
        break;
      default:
        throw new Error(`components: unsupported kind '${c.kind}'`);
    }
  });
  return out;
}
