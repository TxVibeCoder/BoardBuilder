/** Minimal ambient declaration for fft.js (test-only spectral helper dep). */
declare module 'fft.js' {
  export default class FFT {
    constructor(size: number);
    createComplexArray(): number[];
    realTransform(out: number[], input: ArrayLike<number>): void;
    completeSpectrum(out: number[]): void;
  }
}
