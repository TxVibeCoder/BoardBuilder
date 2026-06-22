/**
 * CircuitCore — the top-level pure engine (the DiodeClipperCore successor; no Web Audio types).
 * Wires Netlist → compiled indices → stampers → MnaSystem and exposes the three-method DK seam
 * (engine spec §6): assembleTopology (add/remove/rewire), setValue (knob — glitch-free, warm-start
 * kept), processBlock (the hot path). The per-sample solve runs inside an oversampler (auto 1×/4×/8×,
 * latched at topology time) so nonlinear stages don't alias; the scope reads `scopeDelaySamples` to
 * stay aligned with the audio.
 *
 * getState/setState round-trip the netlist as JSON (single source of truth).
 */

import { buildStampers, type Stamper } from './components';
import {
  cloneNetlist,
  compileNetlist,
  probeHasNoReturnPath,
  type CompiledNetlist,
  type ComponentParams,
  type ComponentSpec,
  type Netlist,
} from './netlist';
import { FLAG_FLOATING, FLAG_NO_RETURN_PATH, FLAG_OK, MnaSystem } from './mnaSystem';
import { autoFactor, Oversampler, type OsFactor } from './oversampler';

export class CircuitCore {
  private net: Netlist;
  private compiled: CompiledNetlist;
  private stampers: Stamper[] = [];
  private readonly mna = new MnaSystem();
  private os: Oversampler = new Oversampler(1);
  private fs: number;
  private dtSub = 0; // timestep at the OVERSAMPLED rate = 1 / (fs · factor)
  private time = 0;
  private readonly specById = new Map<string, ComponentSpec>();
  /** Pin the oversampling factor (testing / A-B). When set, overrides autoFactor. */
  private readonly forcedFactor?: OsFactor;

  /** Bitwise OR of every SolveFlag seen since the last processBlock-free reset (UI teaching badges). */
  flagsAccum = FLAG_OK;

  /** Topology-derived teaching flags (e.g. no-return-path). Computed once per assembleTopology and held
   *  separately from the per-sample solver flags — solveSample resets `mna.flags` every sample, so a
   *  purely structural cue must live outside that reset and be OR'd back in via the `flags` getter. */
  private topoFlags = FLAG_OK;

  /** One solved sub-sample at the oversampled rate, advancing the source clock. Allocated ONCE (a
   *  reused closure) so the per-sample oversampler loop never allocates. */
  private readonly solveSub = (sub: number): number => {
    this.mna.solveSample(this.time, sub);
    this.time += this.dtSub;
    const pi = this.compiled.probeIndex;
    return pi >= 0 ? this.mna.v[pi]! : 0;
  };

  constructor(netlist: Netlist, fs = 48000, opts: { oversample?: OsFactor } = {}) {
    this.net = cloneNetlist(netlist);
    this.fs = this.net.sampleRate || fs;
    this.forcedFactor = opts.oversample;
    this.compiled = compileNetlist(this.net);
    this.assembleTopology();
  }

  /** Structural rebuild (the allowed relatch gap): recompile nets, rebuild stampers, latch the
   *  oversampling factor, reset state. */
  private assembleTopology(): void {
    this.compiled = compileNetlist(this.net);
    this.specById.clear();
    for (const c of this.net.components) this.specById.set(c.id, c);
    this.stampers = buildStampers(this.net, this.compiled);
    const hasNonlinear = this.stampers.some((s) => s.nonlinear);
    // "hot": a nonlinear stage driven well past a diode knee (~0.6 V) — bump to 8× there.
    const hot = hasNonlinear && this.net.components.some((c) => c.kind === 'source' && (c.params.amp ?? 1) > 3);
    const factor = this.forcedFactor ?? autoFactor({ hasNonlinear, hot });
    this.os = new Oversampler(factor);
    this.dtSub = 1 / (this.fs * factor);
    this.mna.flags = FLAG_OK;
    this.mna.setSystem(this.stampers, this.compiled.nodeCount, this.compiled.n, this.dtSub);
    if (!this.compiled.groundOk) this.mna.flags |= FLAG_FLOATING;
    this.topoFlags = probeHasNoReturnPath(this.net) ? FLAG_NO_RETURN_PATH : FLAG_OK;
    this.time = 0;
  }

  setNetlist(n: Netlist): void {
    this.net = cloneNetlist(n);
    this.fs = this.net.sampleRate || this.fs;
    this.assembleTopology();
  }

  /** Knob turn: patch the component's params and re-stamp the linear system; warm-start `v` and
   *  reactive history are preserved, so the sound moves continuously with no relatch. */
  setValue(id: string, vals: Partial<ComponentParams>): void {
    const spec = this.specById.get(id);
    if (!spec) return;
    Object.assign(spec.params, vals);
    this.mna.assembleLinear();
  }

  /** Run `count` samples. `input` feeds any 'guitar'-wave source; `output` receives the probe node
   *  (oversampled solve, decimated back to the base rate). */
  processBlock(input: Float64Array, output: Float64Array, count: number): void {
    if (!(this.compiled.groundOk && this.compiled.n > 0)) {
      for (let i = 0; i < count; i++) output[i] = 0;
      this.flagsAccum |= this.mna.flags;
      return;
    }
    for (let i = 0; i < count; i++) {
      output[i] = this.os.process(input[i] ?? 0, this.solveSub);
      this.flagsAccum |= this.mna.flags; // mna.flags is per-sample; accumulate the "ever-seen" set
    }
  }

  /** Drop warm-start + reactive + oversampler history (e.g. before an offline measurement run). */
  reset(): void {
    this.mna.flags = FLAG_OK;
    this.mna.setSystem(this.stampers, this.compiled.nodeCount, this.compiled.n, this.dtSub);
    this.os.reset();
    if (!this.compiled.groundOk) this.mna.flags |= FLAG_FLOATING;
    this.time = 0;
  }

  getState(): Netlist {
    return cloneNetlist(this.net);
  }
  setState(n: Netlist): void {
    this.setNetlist(n);
  }

  /** Solved voltage at an eyelet (for the scope / DC-bias readout). Ground or unknown ⇒ 0. */
  nodeVoltage(eyelet: string): number {
    const idx = this.compiled.nodeOfEyelet.get(eyelet);
    if (idx === undefined || idx < 0) return 0;
    return this.mna.v[idx] ?? 0;
  }

  get lastIterations(): number {
    return this.mna.lastIterations;
  }
  get flags(): number {
    return this.mna.flags | this.topoFlags;
  }
  /** Oversampler decimation group delay (base-rate samples) — the scope delays its trace by this so
   *  what you SEE stays aligned with what you HEAR. */
  get scopeDelaySamples(): number {
    return this.os.groupDelaySamples;
  }
  get probeIndex(): number {
    return this.compiled.probeIndex;
  }
  get groundOk(): boolean {
    return this.compiled.groundOk;
  }
}
