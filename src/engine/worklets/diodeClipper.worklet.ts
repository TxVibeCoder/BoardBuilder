/**
 * AudioWorklet shell around DiodeClipperCore. DSP lives in the core; this file only
 * marshals buffers and parameters. No allocations in process() (work order §5, §12).
 *
 * Inputs:  0 = source signal (volts) — e.g. a 1 kHz sine or "guitar in"
 * Outputs: 0 = clipped node voltage (volts)
 * Params:  seriesR (Ω, k-rate), diode (index 0=Si/1=Ge/2=LED, k-rate), symmetric (0/1, k-rate)
 */

import { DiodeClipperCore, diodeIdFromIndex, type DiodeId } from '../dsp/diodeClipperCore';

class DiodeClipperProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'seriesR', defaultValue: 4700, minValue: 1, maxValue: 1e6, automationRate: 'k-rate' },
      { name: 'diode', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'symmetric', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new DiodeClipperCore();
  private lastR = NaN;
  private lastDiode = -1;
  private lastSym = -1;

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const inp = inputs[0]?.[0];

    // k-rate params: reconfigure the core only when a value actually changes (no per-sample work).
    const r = parameters['seriesR']![0]!;
    if (r !== this.lastR) {
      this.core.setSeriesR(r);
      this.lastR = r;
    }
    const d = parameters['diode']![0]! | 0;
    if (d !== this.lastDiode) {
      this.core.setDiode(diodeIdFromIndex(d) as DiodeId);
      this.lastDiode = d;
    }
    const s = parameters['symmetric']![0]! | 0;
    if (s !== this.lastSym) {
      this.core.setSymmetric(s !== 0);
      this.lastSym = s;
    }

    for (let i = 0; i < out.length; i++) {
      out[i] = this.core.processSample(inp ? inp[i]! : 0);
    }
    return true;
  }
}

registerProcessor('boardbuilder-diode-clipper', DiodeClipperProcessor);
