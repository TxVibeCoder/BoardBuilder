/**
 * Ambient types for AudioWorkletGlobalScope.
 * TS's DOM lib doesn't include the worklet global scope; this file declares the
 * minimum surface our processors use. (Lifted verbatim from SynthStack — same shape.)
 */

interface AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare var AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

declare function registerProcessor(
  name: string,
  processorCtor: (new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  }) & { parameterDescriptors?: AudioParamDescriptor[] },
): void;

declare var sampleRate: number;
declare var currentFrame: number;
declare var currentTime: number;
