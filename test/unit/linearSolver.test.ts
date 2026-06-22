import { describe, expect, it } from 'vitest';
import { DenseLU } from '../../src/engine/dsp/linearSolver';

/** Build a row-major Float64Array (stride n) from a 2-D array. */
function mat(rows: number[][]): Float64Array {
  const n = rows.length;
  const a = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) a[i * n + j] = rows[i]![j]!;
  return a;
}

function solveWith(lu: DenseLU, A: Float64Array, b: number[], n: number): number[] {
  expect(lu.factor(A, n)).toBe(true);
  const x = new Float64Array(n);
  lu.solve(Float64Array.from(b), x, n);
  return Array.from(x);
}

describe('DenseLU — partial-pivot dense linear solver (engine spec §4)', () => {
  it('solves a 2×2 system to machine precision', () => {
    const lu = new DenseLU(2);
    const x = solveWith(lu, mat([[2, 1], [1, 3]]), [1, 2], 2);
    expect(x[0]!).toBeCloseTo(0.2, 12);
    expect(x[1]!).toBeCloseTo(0.6, 12);
  });

  it('solves a 3×3 system (residual A·x − b ≈ 0)', () => {
    const lu = new DenseLU(3);
    const rows = [[2, 0, 1], [1, 3, 2], [0, 1, 1]];
    const b = [1, 2, 3];
    const x = solveWith(lu, mat(rows), b, 3);
    for (let i = 0; i < 3; i++) {
      let s = 0;
      for (let j = 0; j < 3; j++) s += rows[i]![j]! * x[j]!;
      expect(s).toBeCloseTo(b[i]!, 10);
    }
  });

  it('needs pivoting: a zero leading pivot still solves', () => {
    const lu = new DenseLU(2);
    // [[0,1],[1,0]] · x = [2,3] ⇒ x = [3,2]; fails without row swap
    const x = solveWith(lu, mat([[0, 1], [1, 0]]), [2, 3], 2);
    expect(x[0]!).toBeCloseTo(3, 12);
    expect(x[1]!).toBeCloseTo(2, 12);
  });

  it('reports a singular matrix instead of producing NaN', () => {
    const lu = new DenseLU(2);
    // second row = 2× first ⇒ rank-deficient
    expect(lu.factor(mat([[1, 2], [2, 4]]), 2)).toBe(false);
    expect(lu.singularRow).toBeGreaterThanOrEqual(0);
  });

  it('honors n < capacity (solves the top-left block of a larger matrix)', () => {
    const cap = 8;
    const lu = new DenseLU(cap);
    const A = new Float64Array(cap * cap);
    // top-left 2×2 = [[4,3],[6,3]]; rest left as zeros (unused)
    A[0] = 4; A[1] = 3; A[cap + 0] = 6; A[cap + 1] = 3;
    expect(lu.factor(A, 2)).toBe(true);
    const x = new Float64Array(cap);
    lu.solve(Float64Array.from([10, 12]), x, 2);
    // 4a+3b=10, 6a+3b=12 ⇒ a=1, b=2
    expect(x[0]!).toBeCloseTo(1, 12);
    expect(x[1]!).toBeCloseTo(2, 12);
  });
});
