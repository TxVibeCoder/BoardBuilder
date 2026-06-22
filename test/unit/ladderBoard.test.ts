import { describe, expect, it } from 'vitest';
import { CircuitCore } from '../../src/engine/dsp/circuitCore';
import { FLAG_FLOATING, FLAG_NONFINITE, FLAG_NO_RETURN_PATH } from '../../src/engine/dsp/mnaSystem';
import { BOARD_H_MM, BOARD_W_MM, componentAABB, isPlayable, toNetlist } from '../../src/ui/board/boardModel';
import { ladderBoard } from '../../src/ui/board/synth/ladderBoard';

const FS = 48000;

function core(): CircuitCore {
  // oversample:1 keeps the measured RMS faithful (the filter is linear in the audible range here).
  return new CircuitCore(toNetlist(ladderBoard.build()), FS, { oversample: 1 });
}

/** Drive a sine through extIn (the 'guitar' source); return the settled-tail pk-pk at the probe. */
function pkpk(c: CircuitCore, freq: number, amp = 0.3, n = 16000): number {
  c.reset();
  const inb = new Float64Array(n);
  for (let i = 0; i < n; i++) inb[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS);
  const out = new Float64Array(n);
  c.processBlock(inb, out, n);
  let mn = Infinity;
  let mx = -Infinity;
  const tail = 4000; // settle past the bias/coupling transient before measuring
  for (let i = n - tail; i < n; i++) {
    if (out[i]! < mn) mn = out[i]!;
    if (out[i]! > mx) mx = out[i]!;
  }
  return mx - mn;
}

describe('Transistor Ladder Low-Pass board', () => {
  it('is playable and derives a grounded, finite, fault-free netlist', () => {
    const board = ladderBoard.build();
    expect(isPlayable(board)).toBe(true);
    const c = core();
    expect(c.groundOk).toBe(true);
    const out = new Float64Array(2048);
    c.processBlock(new Float64Array(2048), out, 2048);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(c.flags & FLAG_FLOATING).toBe(0);
    expect(c.flags & FLAG_NONFINITE).toBe(0);
    expect(c.flags & FLAG_NO_RETURN_PATH).toBe(0);
  });

  it('lays out legibly: every part on the board and no two bodies overlapping', () => {
    const board = ladderBoard.build();
    const boxes = board.components
      .filter((c) => c.kind !== 'jumper')
      .map((c) => ({ id: c.id, box: componentAABB(c)! }));
    for (const { id, box } of boxes) {
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

  it('low-passes: passband (low freq) clearly louder than stopband (high freq)', () => {
    const c = core();
    const pass = pkpk(c, 100); // well below the ~1 kHz corner
    const stop = pkpk(c, 8000); // well above it
    expect(pass).toBeGreaterThan(0.4); // signal passes at 100 Hz
    expect(stop).toBeLessThan(0.5 * pass); // strongly attenuated up top
    expect(stop).toBeLessThan(0.12); // ~14 dB+ down by 8 kHz
  });

  it('has a sensible corner (−3 dB ≈ 0.707 of the passband, ~700 Hz)', () => {
    const c = core();
    const pass = pkpk(c, 100);
    // Measured −3 dB point ≈ 700 Hz (a touch below the lone-pole 1/(2π·16k·10n) ≈ 995 Hz because two
    // coincident poles shift the combined −3 dB down). It must fall inside the 500 Hz–1.5 kHz band.
    const m3db = 0.707 * pass;
    expect(pkpk(c, 500)).toBeGreaterThan(m3db); // still in the passband at 500 Hz
    expect(pkpk(c, 1500)).toBeLessThan(m3db); // past the corner by 1.5 kHz
  });

  it('rolls off steeper than one pole (cascaded buffered poles ≈ 2-pole / −12 dB/oct)', () => {
    const c = core();
    // Measure the octave just past the knee (1.4 kHz → 2.8 kHz) where BOTH coincident poles are fully
    // engaged — this is the steepest part of the response. A single RC drops 6 dB/oct; two cascaded
    // poles here drop ~8 dB/oct, clearly steeper than a lone pole. (At very high freq the slope flattens
    // to a small feedthrough floor — the emitter followers leak a little HF straight through, a known
    // limitation of this teaching topology vs. a true balanced ladder; see ladderBoard.ts notes.)
    const a = pkpk(c, 1414);
    const b = pkpk(c, 2828);
    const octaveDb = 20 * Math.log10(b / a);
    expect(octaveDb).toBeLessThan(-7.5); // steeper than a lone −6 dB/oct pole (≈ 2-pole)
  });

  it('cutoff is controllable: lowering the series resistors (Rp) opens the filter up', () => {
    // At a fixed high test tone, a lower series R ⇒ higher cutoff ⇒ MORE signal gets through.
    const board = ladderBoard.build();
    const c = new CircuitCore(toNetlist(board), FS, { oversample: 1 });
    const closed = pkpk(c, 3000); // default Rp ≈ 16k (cutoff ~1 kHz): 3 kHz is in the stopband
    c.setValue('Rp1', { R: 2000 });
    c.setValue('Rp2', { R: 2000 }); // cutoff ≈ 8 kHz now — 3 kHz is back in the passband
    const open = pkpk(c, 3000);
    expect(open).toBeGreaterThan(closed * 1.5); // opening the filter clearly passes more at 3 kHz
  });
});
