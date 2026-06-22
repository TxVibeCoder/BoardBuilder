/**
 * Anti-aliasing oversampler — pure DSP, no Web Audio types, Node-testable (Phase-1 remainder;
 * see CLAUDE.md "Oversample clipping stages" + docs/ENGINE_DESIGN.md).
 *
 * WHY: a nonlinear stage (diode clipper, op-amp into the rails) generates harmonics far above
 * the input fundamental. At a fixed base rate those harmonics fold back below Nyquist as
 * inharmonic *aliases* — the classic "digital fizz" that has no analog counterpart. Running the
 * nonlinear solve at 2×/4×/8× the base rate pushes Nyquist out of the way; band-limiting on the
 * way in (interpolation) and out (decimation) keeps the foldback below audibility.
 *
 * METHOD: a cascade of 2× half-band FIR stages (two stacked = 4×, three = 8×). Half-band filters
 * are the natural choice for power-of-two rate change: every other tap is exactly zero (except the
 * centre = 0.5), so each stage costs ~half the multiplies and has exactly-linear phase. The taps
 * are designed once (windowed-sinc, Hann) at construction; the passband gain is normalised so DC
 * gain is UNITY (a constant in → the same constant out).
 *
 * - Upsample (one base sample → `factor` sub-samples): per 2× stage, zero-stuff ×2 then half-band
 *   low-pass. The interpolation filter is scaled ×2 so the zero-stuffing energy loss is undone and
 *   passband gain stays 1.
 * - Downsample (`factor` sub-samples → one base sample): per 2× stage, half-band low-pass then keep
 *   every other sample (decimate by 2).
 *
 * `groupDelaySamples` is the *total* linear-phase delay of the down-sampling cascade expressed at
 * the BASE (output) rate, so the scope can delay its trace to stay sample-aligned with the audio.
 *
 * Units: dimensionless sample amplitudes in vv (== V here; see units.ts). No allocation per call —
 * every delay line and scratch buffer is preallocated in the constructor.
 */

export type OsFactor = 1 | 2 | 4 | 8;

/**
 * Half-band low-pass length (odd; centre = 0.5, other even taps ≈ 0). A windowed-sinc half-band is
 * −6 dB at the band-rate quarter point with the deep stopband near Nyquist; with this length the
 * stopband floor sits below ~−50 dB, enough to keep post-decimation foldback inaudible.
 */
const HALFBAND_TAPS = 31;

/**
 * Design an odd-length half-band FIR by windowed-sinc. A half-band low-pass has cutoff at Fs/4
 * (quarter of the *stage* rate = the base-rate Nyquist), so h[k] = sinc(k/2)·hann normalised to
 * unity DC gain. The k/2 argument makes every other tap land on a sinc zero ⇒ exactly 0, leaving
 * the centre tap = 0.5 — the half-band signature.
 */
function designHalfband(taps: number): Float64Array {
  const n = taps;
  const mid = (n - 1) / 2;
  const h = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const k = i - mid;
    // Ideal half-band impulse response: sinc(k/2) scaled to a Fs/4 cutoff (0.5 at centre).
    const sinc = k === 0 ? 1 : Math.sin((Math.PI * k) / 2) / ((Math.PI * k) / 2);
    const ideal = 0.5 * sinc;
    // Hann window for a clean, ripple-free stopband.
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const v = ideal * win;
    h[i] = v;
    sum += v;
  }
  // Force exactly-unity DC gain (Σh = 1) so a constant passes through unchanged.
  for (let i = 0; i < n; i++) h[i] = h[i]! / sum;
  return h;
}

/**
 * One 2× half-band rate-change stage. Holds its own FIR delay line so an interpolation stage and a
 * decimation stage never share state. Pure FIR ⇒ linear phase ⇒ integer group delay (n-1)/2 at the
 * stage's *output-of-the-FIR* rate.
 */
class HalfbandStage {
  readonly taps: Float64Array;
  /** Group delay of the FIR in taps' own rate: (length−1)/2. */
  readonly firDelay: number;
  private readonly line: Float64Array; // circular delay line, length = taps
  private pos = 0;

  constructor(taps: Float64Array) {
    this.taps = taps;
    this.firDelay = (taps.length - 1) / 2;
    this.line = new Float64Array(taps.length);
  }

  /** Push one sample through the FIR, returning the filtered output (same rate as input). */
  private fir(x: number): number {
    const line = this.line;
    const taps = this.taps;
    const len = taps.length;
    line[this.pos] = x;
    let acc = 0;
    // Convolve newest..oldest: tap j multiplies the sample j steps back.
    let idx = this.pos;
    for (let j = 0; j < len; j++) {
      acc += taps[j]! * line[idx]!;
      idx = idx === 0 ? len - 1 : idx - 1;
    }
    this.pos = this.pos === len - 1 ? 0 : this.pos + 1;
    return acc;
  }

  /**
   * 2× INTERPOLATE: one input sample → two output samples (zero-stuff then low-pass). The filter is
   * scaled ×2 here so the zero-stuffing's −6 dB is undone and passband gain stays unity.
   * Writes into out[outOff], out[outOff+1].
   */
  upStep(x: number, out: Float64Array, outOff: number): void {
    out[outOff] = 2 * this.fir(x); // the real (non-zero) phase
    out[outOff + 1] = 2 * this.fir(0); // the zero-stuffed phase
  }

  /**
   * 2× DECIMATE: two input samples → one output sample (low-pass then keep one). Both inputs are
   * filtered to advance the FIR state; only the first phase's result is kept.
   */
  downStep(a: number, b: number): number {
    const y = this.fir(a);
    this.fir(b); // advance state for the discarded phase
    return y;
  }

  reset(): void {
    this.line.fill(0);
    this.pos = 0;
  }
}

export class Oversampler {
  readonly factor: OsFactor;
  readonly groupDelaySamples: number;

  /** log2(factor): number of cascaded 2× stages (0 for passthrough). */
  private readonly stages: number;
  private readonly upStages: HalfbandStage[];
  private readonly downStages: HalfbandStage[];
  /** Preallocated ping-pong scratch buffers for the interpolation cascade (sizes 1,2,4,...,factor). */
  private readonly upBuf: Float64Array[];
  /** Preallocated scratch holding the `factor` solved sub-samples. */
  private readonly subBuf: Float64Array;
  /** Preallocated ping-pong scratch buffers for the decimation cascade (sizes factor,...,2,1). */
  private readonly downBuf: Float64Array[];

  constructor(factor: OsFactor) {
    this.factor = factor;
    this.stages = Math.round(Math.log2(factor)); // 1→0, 2→1, 4→2, 8→3
    const taps = designHalfband(HALFBAND_TAPS);

    this.upStages = [];
    this.downStages = [];
    for (let s = 0; s < this.stages; s++) {
      this.upStages.push(new HalfbandStage(taps));
      this.downStages.push(new HalfbandStage(taps));
    }

    // Interpolation buffers: buf[0] has 1 sample, buf[s+1] has 2^(s+1) samples (the stage output).
    this.upBuf = [];
    for (let s = 0; s <= this.stages; s++) this.upBuf.push(new Float64Array(1 << s));
    this.subBuf = new Float64Array(1 << this.stages);
    // Decimation buffers: downBuf[0] holds `factor` solved samples, downBuf[s+1] holds half as many.
    this.downBuf = [];
    for (let s = 0; s <= this.stages; s++) this.downBuf.push(new Float64Array(1 << (this.stages - s)));

    // Total group delay of the decimation cascade, expressed at the BASE (output) rate.
    // A FIR of group delay d running at rate 2^k·base contributes d / 2^k base-rate samples; the
    // first decimation stage runs at the top (sub) rate, the last at 2× base. We round the sum to an
    // integer so the scope can apply a whole-sample trace delay.
    let gd = 0;
    for (let s = 0; s < this.stages; s++) {
      // downStages[s] is the s-th decimation stage, running at rate 2^(stages−s)·base.
      const rateMul = 1 << (this.stages - s);
      gd += this.downStages[s]!.firDelay / rateMul;
    }
    this.groupDelaySamples = Math.round(gd);
  }

  /**
   * Process ONE base-rate input sample. Upsamples x to `factor` sub-samples, runs `solveSub` on each
   * in time order, then downsamples the `factor` results to one base-rate output sample.
   * factor === 1 is a pure passthrough: return solveSub(x).
   */
  process(x: number, solveSub: (sub: number) => number): number {
    if (this.stages === 0) return solveSub(x);

    // --- Interpolate: cascade x up through each 2× stage into subBuf (the top-rate sub-samples). ---
    let cur = this.upBuf[0]!;
    cur[0] = x;
    for (let s = 0; s < this.stages; s++) {
      const src = this.upBuf[s]!;
      const dst = this.upBuf[s + 1]!;
      const stage = this.upStages[s]!;
      for (let i = 0; i < src.length; i++) stage.upStep(src[i]!, dst, i * 2);
      cur = dst;
    }

    // --- Solve each sub-sample (cur now holds `factor` top-rate samples) into subBuf. ---
    const sub = this.subBuf;
    for (let i = 0; i < sub.length; i++) sub[i] = solveSub(cur[i]!);

    // --- Decimate: cascade down through each 2× stage, halving the count each pass, to ONE sample. ---
    const d0 = this.downBuf[0]!;
    for (let i = 0; i < sub.length; i++) d0[i] = sub[i]!;
    for (let s = 0; s < this.stages; s++) {
      const src = this.downBuf[s]!;
      const dst = this.downBuf[s + 1]!;
      const stage = this.downStages[s]!;
      for (let i = 0; i < dst.length; i++) dst[i] = stage.downStep(src[2 * i]!, src[2 * i + 1]!);
    }
    return this.downBuf[this.stages]![0]!;
  }

  /** Clear all FIR delay lines so the next sample starts from silence. */
  reset(): void {
    for (const s of this.upStages) s.reset();
    for (const s of this.downStages) s.reset();
  }
}

/**
 * Pick the oversampling factor at TOPOLOGY time (refactored only on a topology change, never per
 * sample). Rule (CLAUDE.md): 1× if the circuit is fully linear; 4× if any nonlinear element is
 * present (diode / op-amp into saturation); 8× when a nonlinear stage is hot-driven (peak·drive
 * relative to the diode knee is high) and aliasing would otherwise be severe.
 */
export function autoFactor(opts: { hasNonlinear: boolean; hot: boolean }): OsFactor {
  if (!opts.hasNonlinear) return 1;
  return opts.hot ? 8 : 4;
}
