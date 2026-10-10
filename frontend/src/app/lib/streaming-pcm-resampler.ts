/** Causal, stateful microphone conversion. The 63-tap windowed-sinc filter
 * limits input above the 16 kHz Nyquist band before decimation. Keeping the
 * ring and cumulative sample counter across callbacks prevents per-chunk
 * rounding losses and filter resets. Group delay is 31 source samples. */
export class StreamingPcm16Resampler {
  readonly sourceRate: number;
  readonly targetRate: number;
  readonly groupDelayInputSamples: number;
  readonly #kernel: Float64Array;
  readonly #history = new Float32Array(128);
  #inputSamples = 0;
  #outputSamples = 0;

  constructor(sourceRate: number, targetRate: number) {
    if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
      throw new RangeError('Microphone resampler requires positive rates.');
    }
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
    this.groupDelayInputSamples = sourceRate <= targetRate ? 0 : 31;
    const cutoff = Math.min(0.5, 0.45 * targetRate / sourceRate);
    const kernel = new Float64Array(63);
    let sum = 0;
    for (let tap = 0; tap < kernel.length; tap += 1) {
      const distance = tap - 31;
      const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * tap / 62) + 0.08 * Math.cos(4 * Math.PI * tap / 62);
      kernel[tap] = sinc * window;
      sum += kernel[tap]!;
    }
    for (let tap = 0; tap < kernel.length; tap += 1) kernel[tap] /= sum;
    this.#kernel = kernel;
  }

  get inputSampleCount(): number { return this.#inputSamples; }
  get outputSampleCount(): number { return this.#outputSamples; }
  get groupDelayMs(): number { return this.groupDelayInputSamples * 1000 / this.sourceRate; }

  #filteredAt(center: number): number {
    let filtered = 0;
    for (let tap = 0; tap < this.#kernel.length; tap += 1) {
      const sourceIndex = center - tap;
      if (sourceIndex >= 0) filtered += this.#history[sourceIndex % this.#history.length]! * this.#kernel[tap]!;
    }
    return filtered;
  }

  process(input: Float32Array): Int16Array {
    const expected = Math.floor((this.#inputSamples + input.length) * this.targetRate / this.sourceRate) - this.#outputSamples;
    const output = new Int16Array(expected);
    let written = 0;
    for (const raw of input) {
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      this.#history[this.#inputSamples % this.#history.length] = sample;
      this.#inputSamples += 1;
      while ((this.#outputSamples + 1) * this.sourceRate <= this.#inputSamples * this.targetRate) {
        const position = this.#outputSamples * this.sourceRate / this.targetRate;
        const center = Math.floor(position);
        // Low-rate capture can occur with Bluetooth HFP. Duplicate its latest
        // available source sample; no decimation filter is needed in that path.
        const phase = position - center;
        const filtered = this.sourceRate <= this.targetRate
          ? this.#history[center % this.#history.length]!
          : this.#filteredAt(center) * (1 - phase) + this.#filteredAt(Math.ceil(position)) * phase;
        const clipped = Math.max(-1, Math.min(1, filtered));
        output[written++] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
        this.#outputSamples += 1;
      }
    }
    return output;
  }
}
