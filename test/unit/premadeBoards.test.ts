import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import { FLAG_FLOATING, FLAG_NO_RETURN_PATH, FLAG_NONFINITE } from '../../src/engine/dsp/mnaSystem';
import { BOARD_H_MM, BOARD_W_MM, componentAABB, isPlayable, toNetlist } from '../../src/ui/board/boardModel';
import { PREMADE_CIRCUITS } from '../../src/ui/board/premadeBoards';

const FS = 48000;

function core(id: string): CircuitCore {
  const c = PREMADE_CIRCUITS.find((p) => p.id === id)!;
  return new CircuitCore(toNetlist(c.build()), FS, { oversample: 1 });
}

/** Settle a DC input, return the final probe voltage. */
function dc(c: CircuitCore, vin: number, n = 4000): number {
  c.reset();
  const inb = new Float64Array(n).fill(vin);
  const out = new Float64Array(n);
  c.processBlock(inb, out, n);
  return out[n - 1]!;
}

/** Drive a sine through extIn; return {pkpk, mean} over the settled tail. */
function ac(c: CircuitCore, freq: number, amp: number, n = 9600): { pkpk: number; mean: number } {
  c.reset();
  const inb = new Float64Array(n);
  for (let i = 0; i < n; i++) inb[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS);
  const out = new Float64Array(n);
  c.processBlock(inb, out, n);
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  const tail = 2400;
  for (let i = n - tail; i < n; i++) {
    if (out[i]! < mn) mn = out[i]!;
    if (out[i]! > mx) mx = out[i]!;
    sum += out[i]!;
  }
  return { pkpk: mx - mn, mean: sum / tail };
}

describe('premade boards — legibility + electrical sanity (shared)', () => {
  for (const p of PREMADE_CIRCUITS) {
    describe(p.name, () => {
      const board = p.build();

      it('is playable and derives a grounded, finite, fault-free netlist', () => {
        expect(isPlayable(board)).toBe(true);
        const c = new CircuitCore(toNetlist(board), FS, { oversample: 1 });
        expect(c.groundOk).toBe(true);
        const out = new Float64Array(2048);
        c.processBlock(new Float64Array(2048), out, 2048);
        expect(out.every((v) => Number.isFinite(v))).toBe(true);
        // a correctly + fully wired board has no floating node, a real return path, and stays solvable
        expect(c.flags & FLAG_FLOATING).toBe(0);
        expect(c.flags & FLAG_NONFINITE).toBe(0);
        expect(c.flags & FLAG_NO_RETURN_PATH).toBe(0);
      });

      it('lays out legibly: every part within the board and no two bodies overlapping', () => {
        const boxes = board.components
          .filter((c) => c.kind !== 'jumper')
          .map((c) => ({ id: c.id, box: componentAABB(c)! }));
        for (const { id, box } of boxes) {
          expect(box, id).not.toBeNull();
          expect(box.x, `${id} left`).toBeGreaterThanOrEqual(-0.5);
          expect(box.y, `${id} top`).toBeGreaterThanOrEqual(-0.5);
          expect(box.x + box.w, `${id} right`).toBeLessThanOrEqual(BOARD_W_MM + 0.5);
          expect(box.y + box.h, `${id} bottom`).toBeLessThanOrEqual(BOARD_H_MM + 0.5);
        }
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]!.box;
            const b = boxes[j]!.box;
            const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
            expect(overlap, `${boxes[i]!.id} overlaps ${boxes[j]!.id}`).toBe(false);
          }
        }
      });
    });
  }
});

describe('premade boards — each behaves like its name (audio battery)', () => {
  it('Voltage Divider: equal legs ⇒ output ≈ half the input', () => {
    expect(dc(core('divider'), 1)).toBeCloseTo(0.5, 2); // R1 = R2 = 10k
  });

  it('RC Low-Pass: passes lows, rolls off highs', () => {
    const c = core('rc-lowpass');
    expect(ac(c, 100, 1).pkpk).toBeGreaterThan(1.8); // ~full at 100 Hz (pk-pk ≈ 2)
    expect(ac(c, 8000, 1).pkpk).toBeLessThan(0.6); // strongly attenuated at 8 kHz
  });

  it('Diode Clipper: clamps the peaks near the diode knee', () => {
    const { pkpk } = ac(core('diode-clipper'), 500, 1); // source amp 2 ⇒ ~2 V drive into Si pair
    expect(pkpk).toBeGreaterThan(0.4); // it conducts
    expect(pkpk).toBeLessThan(1.8); // …but is clamped (a clean 2 V drive would be ~4 V pk-pk)
  });

  it('Transistor Boost: amplifies, output AC-coupled (centred near 0 V)', () => {
    const c = core('bjt-boost');
    const inAmp = 0.05;
    const { pkpk, mean } = ac(c, 500, inAmp);
    expect(pkpk).toBeGreaterThan(2 * inAmp * 2); // gain clearly > 2× (≈ Rc/Re)
    expect(Math.abs(mean)).toBeLessThan(0.3); // coupling cap blocks the collector DC bias
  });
});
