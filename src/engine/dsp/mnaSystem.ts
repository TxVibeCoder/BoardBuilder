/**
 * The MNA system: owns the matrices and runs the warm-started per-sample Newton solve (engine spec
 * §3, §4). The companion-linearized system A·v_next = b is solved for the next iterate; a linear
 * circuit converges in one solve. Only the `LinearSolver` (LU) is an external seam — the Newton driver
 * lives here. No allocation in `solveSample` — every buffer is preallocated to `capacity`.
 */

import { DenseLU } from './linearSolver';
import { StampContext, type Stamper } from './components';
import { DV_MAX, GMIN_COND, GMIN_FLOAT, MAX_ITER, NMAX, V_TOL } from './constants';

export const FLAG_OK = 0;
export const FLAG_FLOATING = 1;
export const FLAG_NONCONVERGED = 2;
export const FLAG_NONFINITE = 4;
export const FLAG_OPAMP_NO_FEEDBACK = 8;

export class MnaSystem {
  private cap: number;
  private G0: Float64Array;
  private RHS0: Float64Array;
  private A: Float64Array;
  private b: Float64Array;
  private bbase: Float64Array;
  v: Float64Array;
  private vnext: Float64Array;
  private solver: DenseLU;
  private ctx = new StampContext();

  // stamper partitions
  private all: Stamper[] = [];
  private nonReactive: Stamper[] = [];
  private reactive: Stamper[] = [];
  private nonlinear: Stamper[] = [];
  private dynamic: Stamper[] = [];

  nodeCount = 0;
  n = 0;
  dt = 0;
  flags = FLAG_OK;
  lastIterations = 0;

  constructor(capacity = NMAX) {
    this.cap = capacity;
    this.G0 = new Float64Array(capacity * capacity);
    this.A = new Float64Array(capacity * capacity);
    this.RHS0 = new Float64Array(capacity);
    this.b = new Float64Array(capacity);
    this.bbase = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.vnext = new Float64Array(capacity);
    this.solver = new DenseLU(capacity);
  }

  private ensureCapacity(n: number): void {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    this.cap = cap;
    this.G0 = new Float64Array(cap * cap);
    this.A = new Float64Array(cap * cap);
    this.RHS0 = new Float64Array(cap);
    this.b = new Float64Array(cap);
    this.bbase = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.vnext = new Float64Array(cap);
    this.solver = new DenseLU(cap);
  }

  /** Install a compiled stamper set. Partitions groups, sizes buffers, resets warm-start + state. */
  setSystem(stampers: Stamper[], nodeCount: number, n: number, dt: number): void {
    this.ensureCapacity(Math.max(n, 1));
    this.all = stampers;
    this.nonReactive = stampers.filter((s) => !s.reactive);
    this.reactive = stampers.filter((s) => s.reactive);
    this.nonlinear = stampers.filter((s) => s.nonlinear);
    this.dynamic = stampers.filter((s) => typeof s.loadDynamic === 'function');
    // Invariant (assembly-time, out of the hot path): the stampers must own exactly the aux rows the
    // netlist reserved. A mismatch means an unfilled aux row that LU would treat as singular and the
    // circuit would silently go dead — so fail loudly here instead.
    let auxSum = 0;
    for (const s of stampers) auxSum += s.auxRows;
    if (nodeCount + auxSum !== n) {
      throw new Error(`MNA dimension drift: nodeCount(${nodeCount}) + ΣauxRows(${auxSum}) ≠ n(${n})`);
    }
    this.nodeCount = nodeCount;
    this.n = n;
    this.dt = dt;
    for (const s of stampers) s.reset();
    this.v.fill(0);
    this.vnext.fill(0);
    this.assembleLinear();
  }

  /** (Re)build the static linear system G0/RHS0. Run on topology change AND on a knob turn (cheap at
   *  these sizes); warm-start `v` and reactive history are NOT reset here, so a knob turn stays
   *  continuous. */
  assembleLinear(): void {
    const cap = this.cap;
    this.G0.fill(0);
    this.RHS0.fill(0);
    const ctx = this.ctx;
    ctx.A = this.G0;
    ctx.b = this.RHS0;
    ctx.v = this.v;
    ctx.stride = cap;
    ctx.n = this.n;
    ctx.nodeCount = this.nodeCount;
    ctx.dt = this.dt;

    // pass 1: non-reactive linear conductances (resistor, source Norton g, op-amp nullor, pot)
    for (const s of this.nonReactive) s.stampLinear(ctx);

    // pass 2: pick each reactive companion method from the local stiffness seen on G0's diagonal
    for (const s of this.reactive) {
      const a = s.nodes[0]!;
      const bIdx = s.nodes[1]!;
      const da = a >= 0 ? this.G0[a * cap + a]! : Infinity;
      const db = bIdx >= 0 ? this.G0[bIdx * cap + bIdx]! : Infinity;
      let gLocal: number;
      if (a < 0) gLocal = db;
      else if (bIdx < 0) gLocal = da;
      else gLocal = Math.min(da, db);
      if (!Number.isFinite(gLocal)) gLocal = 0;
      s.prepare!(this.dt, gLocal);
    }
    for (const s of this.reactive) s.stampLinear(ctx);

    // conditioning: weak tie to ground on every node diagonal (does NOT load high-Z; see DECISIONS)
    for (let i = 0; i < this.nodeCount; i++) this.G0[i * cap + i] = this.G0[i * cap + i]! + GMIN_COND;
  }

  private factorWithFallback(): boolean {
    if (this.solver.factor(this.A, this.n)) return true;
    // Pin singular rows ONE AT A TIME and re-factor until non-singular or we give up. Each pin
    // de-singularizes a whole floating subnet, so several disjoint stray sub-circuits all get pinned
    // (the grounded part still solves) instead of the first failure zeroing the whole board. A node
    // row → floating-node teaching flag; an aux row → an op-amp with no feedback (pin it too so the
    // rest of the circuit survives). Bounded by n+1 passes.
    const maxPins = this.n + 1;
    for (let pass = 0; pass < maxPins; pass++) {
      const row = this.solver.singularRow;
      if (row < 0) break;
      const d = row * this.cap + row;
      this.A[d] = this.A[d]! + GMIN_FLOAT;
      this.flags |= row < this.nodeCount ? FLAG_FLOATING : FLAG_OPAMP_NO_FEEDBACK;
      if (this.solver.factor(this.A, this.n)) return true;
    }
    this.v.fill(0, 0, this.n);
    this.flags |= FLAG_NONFINITE;
    return false;
  }

  /** One sample. Reads the source/companion RHS, warm-started Newton on the nonlinear elements,
   *  commits reactive state. Writes the solution into `v`. */
  solveSample(time: number, extIn: number): void {
    const ctx = this.ctx;
    ctx.A = this.A;
    ctx.b = this.b;
    ctx.v = this.v;
    ctx.stride = this.cap;
    ctx.n = this.n;
    ctx.nodeCount = this.nodeCount;
    ctx.dt = this.dt;
    ctx.time = time;
    ctx.extIn = extIn;
    // Transient flags reflect THIS sample, so a teaching badge clears when the condition resolves
    // (a topology-level fault like no-ground is re-asserted by circuitCore, not here).
    this.flags = FLAG_OK;

    // bbase = RHS0 + per-sample dynamic injections (source value + companion history currents)
    this.b.set(this.RHS0);
    for (const s of this.dynamic) s.loadDynamic!(ctx);
    this.bbase.set(this.b);

    let bad = false;
    if (this.nonlinear.length === 0) {
      this.A.set(this.G0);
      if (this.factorWithFallback()) this.solver.solve(this.b, this.v, this.n);
      else bad = true;
    } else {
      let converged = false;
      let iter = 0;
      for (; iter < MAX_ITER; iter++) {
        this.A.set(this.G0);
        this.b.set(this.bbase);
        for (const s of this.nonlinear) s.stampNonlinear!(ctx);
        if (!this.factorWithFallback()) {
          bad = true;
          break;
        }
        this.solver.solve(this.b, this.vnext, this.n);
        let maxStep = 0;
        for (let i = 0; i < this.n; i++) {
          if (i < this.nodeCount) {
            let step = this.vnext[i]! - this.v[i]!;
            if (step > DV_MAX) step = DV_MAX;
            else if (step < -DV_MAX) step = -DV_MAX;
            this.v[i] = this.v[i]! + step;
            const a = step < 0 ? -step : step;
            if (a > maxStep) maxStep = a;
          } else {
            this.v[i] = this.vnext[i]!;
          }
        }
        if (maxStep < V_TOL) {
          converged = true;
          iter++;
          break;
        }
      }
      this.lastIterations = iter;
      if (!converged && !bad) this.flags |= FLAG_NONCONVERGED;
    }

    for (let i = 0; i < this.n; i++) {
      if (!Number.isFinite(this.v[i]!)) {
        this.v.fill(0, 0, this.n);
        this.flags |= FLAG_NONFINITE;
        bad = true;
        break;
      }
    }
    // Advance reactive history ONLY from a good solve. On a failed/zeroed sample, HOLD the previous
    // history so a single solver hiccup can't poison the cap/inductor integrator state going forward.
    if (!bad) for (const s of this.all) s.commitSample(ctx);
  }
}
