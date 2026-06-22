/**
 * Dense LU linear solver (Doolittle elimination with partial pivoting) on preallocated flat
 * row-major arrays. This is the single swap seam for a future WASM/DK kernel (engine spec §4, §6):
 * the Newton driver only ever talks to the LinearSolver interface.
 *
 * - No allocation in factor()/solve() — all scratch preallocated in the constructor.
 * - factor() returns false on a (near-)singular pivot and records the offending ORIGINAL row index in
 *   singularRow. That is the ONE place the engine detects a floating node / op-amp without feedback.
 * - Matrices are row-major with a FIXED stride === capacity (the working matrix is NMAX*NMAX), so a
 *   system of size n ≤ capacity is the top-left n×n block. `n` is passed per call.
 */

import { PIVOT_EPS } from './constants';

export interface LinearSolver {
  readonly capacity: number;
  /** In-place LU factorization of the top-left n×n block of A (stride === capacity). false ⇒ singular. */
  factor(A: Float64Array, n: number): boolean;
  /** Solve A·x = b for the most recent factor(); x may alias b. Reads b[0..n), writes x[0..n). */
  solve(b: Float64Array, x: Float64Array, n: number): void;
  /** Original-row index of the singular pivot from the last failed factor(), else -1. */
  readonly singularRow: number;
}

export class DenseLU implements LinearSolver {
  readonly capacity: number;
  private readonly lu: Float64Array; // capacity*capacity, holds the in-place LU
  private readonly piv: Int32Array; // row permutation: piv[i] = original row now in position i
  private readonly y: Float64Array; // forward-substitution scratch
  singularRow = -1;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.lu = new Float64Array(capacity * capacity);
    this.piv = new Int32Array(capacity);
    this.y = new Float64Array(capacity);
  }

  factor(A: Float64Array, n: number): boolean {
    const lu = this.lu;
    const piv = this.piv;
    const cap = this.capacity;
    this.singularRow = -1;

    for (let i = 0; i < n; i++) {
      const ri = i * cap;
      for (let j = 0; j < n; j++) lu[ri + j] = A[ri + j]!;
      piv[i] = i;
    }

    for (let k = 0; k < n; k++) {
      // partial pivot: largest |lu[i][k]| for i ≥ k
      let p = k;
      let max = Math.abs(lu[k * cap + k]!);
      for (let i = k + 1; i < n; i++) {
        const a = Math.abs(lu[i * cap + k]!);
        if (a > max) {
          max = a;
          p = i;
        }
      }
      if (max < PIVOT_EPS) {
        this.singularRow = piv[k]!;
        return false;
      }
      if (p !== k) {
        const rk = k * cap;
        const rp = p * cap;
        for (let j = 0; j < n; j++) {
          const t = lu[rk + j]!;
          lu[rk + j] = lu[rp + j]!;
          lu[rp + j] = t;
        }
        const tp = piv[k]!;
        piv[k] = piv[p]!;
        piv[p] = tp;
      }
      const pivot = lu[k * cap + k]!;
      for (let i = k + 1; i < n; i++) {
        const ri = i * cap;
        const f = lu[ri + k]! / pivot;
        lu[ri + k] = f;
        const rk = k * cap;
        for (let j = k + 1; j < n; j++) lu[ri + j] = lu[ri + j]! - f * lu[rk + j]!;
      }
    }
    return true;
  }

  solve(b: Float64Array, x: Float64Array, n: number): void {
    const lu = this.lu;
    const piv = this.piv;
    const cap = this.capacity;
    const y = this.y;
    // forward substitution: L·y = P·b  (L has unit diagonal)
    for (let i = 0; i < n; i++) {
      let s = b[piv[i]!]!;
      const ri = i * cap;
      for (let j = 0; j < i; j++) s -= lu[ri + j]! * y[j]!;
      y[i] = s;
    }
    // back substitution: U·x = y
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i]!;
      const ri = i * cap;
      for (let j = i + 1; j < n; j++) s -= lu[ri + j]! * x[j]!;
      x[i] = s / lu[ri + i]!;
    }
  }
}
