/**
 * CircuitCore — the top-level pure engine (the DiodeClipperCore successor; no Web Audio types).
 * Wires Netlist → compiled indices → stampers → MnaSystem and exposes the three-method DK seam
 * (engine spec §6): assembleTopology (add/remove/rewire), setValue (knob — glitch-free, warm-start
 * kept), processBlock (the hot path). Runs at OS=1 for this milestone; the oversampler wraps
 * processBlock without touching this contract.
 *
 * getState/setState round-trip the netlist as JSON (single source of truth).
 */

import { buildStampers, type Stamper } from './components';
import {
  cloneNetlist,
  compileNetlist,
  type CompiledNetlist,
  type ComponentParams,
  type ComponentSpec,
  type Netlist,
} from './netlist';
import { FLAG_FLOATING, FLAG_OK, MnaSystem } from './mnaSystem';

export class CircuitCore {
  private net: Netlist;
  private compiled: CompiledNetlist;
  private stampers: Stamper[] = [];
  private readonly mna = new MnaSystem();
  private fs: number;
  private dt: number;
  private time = 0;
  private readonly specById = new Map<string, ComponentSpec>();

  /** Bitwise OR of every SolveFlag seen since the last processBlock-free reset (UI teaching badges). */
  flagsAccum = FLAG_OK;

  constructor(netlist: Netlist, fs = 48000) {
    this.net = cloneNetlist(netlist);
    this.fs = this.net.sampleRate || fs;
    this.dt = 1 / this.fs;
    this.compiled = compileNetlist(this.net);
    this.assembleTopology();
  }

  /** Structural rebuild (the allowed relatch gap): recompile nets, rebuild stampers, reset state. */
  private assembleTopology(): void {
    this.compiled = compileNetlist(this.net);
    this.specById.clear();
    for (const c of this.net.components) this.specById.set(c.id, c);
    this.stampers = buildStampers(this.net, this.compiled);
    this.mna.flags = FLAG_OK;
    this.mna.setSystem(this.stampers, this.compiled.nodeCount, this.compiled.n, this.dt);
    if (!this.compiled.groundOk) this.mna.flags |= FLAG_FLOATING;
    this.time = 0;
  }

  setNetlist(n: Netlist): void {
    this.net = cloneNetlist(n);
    this.fs = this.net.sampleRate || this.fs;
    this.dt = 1 / this.fs;
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

  /** Run `count` samples. `input` feeds any 'guitar'-wave source; `output` receives the probe node. */
  processBlock(input: Float64Array, output: Float64Array, count: number): void {
    const pi = this.compiled.probeIndex;
    const live = this.compiled.groundOk && this.compiled.n > 0;
    for (let i = 0; i < count; i++) {
      if (live) {
        this.mna.solveSample(this.time, input[i] ?? 0);
        output[i] = pi >= 0 ? this.mna.v[pi]! : 0;
      } else {
        output[i] = 0;
      }
      this.flagsAccum |= this.mna.flags; // mna.flags is per-sample now; accumulate the "ever-seen" set
      this.time += this.dt;
    }
  }

  /** Drop warm-start + reactive history (e.g. before an offline measurement run). */
  reset(): void {
    this.mna.flags = FLAG_OK;
    this.mna.setSystem(this.stampers, this.compiled.nodeCount, this.compiled.n, this.dt);
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
    return this.mna.flags;
  }
  get scopeDelaySamples(): number {
    return 0; // OS=1 for this milestone; the oversampler will export its decimation group delay
  }
  get probeIndex(): number {
    return this.compiled.probeIndex;
  }
  get groundOk(): boolean {
    return this.compiled.groundOk;
  }
}
