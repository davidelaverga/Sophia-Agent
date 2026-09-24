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
    expect(elapsed.sort((a, b) => a - b)[Math.floor(elapsed.length / 2)]).toBeLessThan(20);
  });
});
