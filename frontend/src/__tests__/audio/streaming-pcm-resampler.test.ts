import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { StreamingPcm16Resampler } from '../../app/lib/streaming-pcm-resampler';

function sine(rate: number, frequency: number, seconds: number): Float32Array {
  return Float32Array.from({ length: rate * seconds }, (_, index) => Math.sin(2 * Math.PI * frequency * index / rate));
}

function rms(samples: Int16Array, skip = 0): number {
  const window = samples.subarray(skip);
  return Math.sqrt(window.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / window.length);
}

function sineSnrDb(samples: Int16Array, sourceRate: number, frequency: number, delay: number): number {
  let signal = 0;
  let error = 0;
  for (let index = 2000; index < samples.length; index += 1) {
    const ideal = Math.sin(2 * Math.PI * frequency * (index * sourceRate / 16000 - delay) / sourceRate);
    const actual = samples[index]! / 32768;
    signal += ideal * ideal;
    error += (actual - ideal) ** 2;
  }
  return 10 * Math.log10(signal / error);
}

describe('streaming microphone PCM resampler', () => {
  it('passes speech-band energy and filters input above the 16 kHz Nyquist limit', () => {
    for (const sourceRate of [44100, 48000]) {
      const speech = new StreamingPcm16Resampler(sourceRate, 16000).process(sine(sourceRate, 1000, 1));
      const alias = new StreamingPcm16Resampler(sourceRate, 16000).process(sine(sourceRate, 10000, 1));
      expect(rms(speech, 2000)).toBeGreaterThan(0.6);
      expect(rms(speech, 2000)).toBeLessThan(0.79); // 1 kHz gain within ±1 dB of 0.707 RMS.
      expect(rms(alias, 2000) / rms(speech, 2000)).toBeLessThan(10 ** (-30 / 20));
    }
  });

  it('uses fractional phase at 44.1 kHz without speech-band timing distortion', () => {
    for (const [frequency, minimumSnr] of [[1000, 40], [3000, 30]]) {
      const stream = new StreamingPcm16Resampler(44100, 16000);
      const output = stream.process(sine(44100, frequency!, 1));
      const snr = sineSnrDb(output, 44100, frequency!, stream.groupDelayInputSamples);
      console.info(`44.1 kHz fractional-phase SNR at ${frequency} Hz: ${snr.toFixed(1)} dB`);
      expect(snr).toBeGreaterThan(minimumSnr!);
    }
  });

  it('accepts low-rate Bluetooth capture without throwing or miscounting samples', () => {
    for (const sourceRate of [8000, 16000]) {
      const stream = new StreamingPcm16Resampler(sourceRate, 16000);
      const output = stream.process(sine(sourceRate, 1000, 1));
      expect(output.length).toBe(16000);
      expect(stream.groupDelayInputSamples).toBe(0);
      expect(rms(output, 2000)).toBeGreaterThan(0.6);
    }
  });

  it('is bit continuous across irregular callback chunks and accounts for every output sample', () => {
    const input = Float32Array.from({ length: 44103 }, (_, index) => Math.sin(index / 37) * 0.8);
    const whole = new StreamingPcm16Resampler(44100, 16000).process(input);
    const stream = new StreamingPcm16Resampler(44100, 16000);
    const pieces: Int16Array[] = [];
    let cursor = 0;
    for (const length of [1, 17, 4096, 3, 711, 4096, 2, 9, 2031, 12345, 4096, 16796]) {
      pieces.push(stream.process(input.subarray(cursor, cursor + length)));
      cursor += length;
    }
    if (cursor < input.length) pieces.push(stream.process(input.subarray(cursor)));
    const joined = new Int16Array(pieces.reduce((total, piece) => total + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) { joined.set(piece, offset); offset += piece.length; }
    expect(joined).toEqual(whole);
    expect(stream.inputSampleCount).toBe(input.length);
    expect(stream.outputSampleCount).toBe(Math.floor(input.length * 16000 / 44100));
    expect(joined.byteLength).toBe(stream.outputSampleCount * 2);
    expect(stream.groupDelayMs).toBeLessThan(1);
  });

  it('emits exact cumulative samples even when 44.1 kHz callback frame bytes vary', () => {
    const stream = new StreamingPcm16Resampler(44100, 16000);
    const lengths = Array.from({ length: 100 }, () => stream.process(new Float32Array(4096)).byteLength);
    expect(new Set(lengths)).toEqual(new Set([2972, 2974]));
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(stream.outputSampleCount * 2);
    expect(lengths.every((length) => length > 0 && length % 2 === 0)).toBe(true);
  });

  it('accounts for ten minutes without rounding drift', () => {
    const stream = new StreamingPcm16Resampler(44100, 16000);
    const chunk = new Float32Array(4096);
    const total = 44100 * 600;
    for (let offset = 0; offset < total; offset += chunk.length) stream.process(chunk.subarray(0, Math.min(chunk.length, total - offset)));
    expect(stream.inputSampleCount).toBe(total);
    expect(stream.outputSampleCount).toBe(16000 * 600);
  }, 60_000);

  it('keeps per-callback CPU and filter group delay below the 4096-sample callback budget', () => {
    const input = sine(48000, 600, 1);
    const elapsed: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = new StreamingPcm16Resampler(48000, 16000);
      for (let offset = 0; offset < input.length; offset += 4096) {
        const start = performance.now();
        stream.process(input.subarray(offset, offset + 4096));
        elapsed.push(performance.now() - start);
      }
      expect(stream.outputSampleCount).toBe(16000);
      expect(stream.groupDelayMs).toBeLessThan(1);
    }
    elapsed.sort((a, b) => a - b);
    const median = elapsed[Math.floor(elapsed.length / 2)]!;
    const p95 = elapsed[Math.floor(elapsed.length * 0.95)]!;
    console.info(`Streaming PCM CPU per callback: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
    expect(median).toBeLessThanOrEqual(5);
  });
});
