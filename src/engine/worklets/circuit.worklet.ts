/**
 * AudioWorklet shell around CircuitCore — the live-audio path for the generalized engine. The DSP is in
 * the pure core; this shell only marshals buffers and forwards control messages. No DSP and no
 * allocation in process() — the f64 scratch and the core are built on 'load', off the render path.
 *
 * Messages (main → worklet, via port):
 *   { type: 'load', netlist }      build/replace the circuit (a topology relatch — brief gap, acceptable)
 *   { type: 'set', id, params }    knob turn → core.setValue(id, params) (glitch-free, warm-start kept)
 * Audio:  input 0 = the live signal feeding any wave:'guitar' source; output 0 = the probe node (volts).
 * The worklet posts { type: 'flags', flags } at a low rate so the UI can show teaching badges.
 */

import { CircuitCore } from '../dsp/circuitCore';
import type { ComponentParams, Netlist } from '../dsp/netlist';

const QUANTUM = 128;

type InMsg =
  | { type: 'load'; netlist: Netlist }
  | { type: 'set'; id: string; params: Partial<ComponentParams> };

class CircuitProcessor extends AudioWorkletProcessor {
  private core: CircuitCore | null = null;
  private readonly inBuf = new Float64Array(QUANTUM);
  private readonly outBuf = new Float64Array(QUANTUM);
  private blockCount = 0;
  private lastFlags = -1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent): void => {
      const msg = e.data as InMsg;
      if (msg.type === 'load') {
        // Building the core allocates (Maps/typed arrays) — fine here, this is off the render path.
        try {
          this.core = new CircuitCore(msg.netlist);
        } catch {
          this.core = null;
        }
        this.lastFlags = -1;
      } else if (msg.type === 'set' && this.core) {
        this.core.setValue(msg.id, msg.params);
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const core = this.core;
    if (!core) {
      out.fill(0);
      return true;
    }
    const n = out.length <= QUANTUM ? out.length : QUANTUM;
    const inp = inputs[0]?.[0];
    for (let i = 0; i < n; i++) this.inBuf[i] = inp ? (inp[i] ?? 0) : 0;
    core.processBlock(this.inBuf, this.outBuf, n);
    for (let i = 0; i < n; i++) out[i] = this.outBuf[i]!;

    // low-rate flag report for teaching badges (~every 64 blocks ≈ 170 ms), only on change
    if ((this.blockCount++ & 63) === 0 && core.flags !== this.lastFlags) {
      this.lastFlags = core.flags;
      this.port.postMessage({ type: 'flags', flags: core.flags });
    }
    return true;
  }
}

registerProcessor('boardbuilder-circuit', CircuitProcessor);
