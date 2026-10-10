import { describe, expect, it } from 'vitest'

import { pcm16Base64FromFloat32 } from '@/app/lib/gemini-browser-live-websocket-dogfood'

/**
 * Offline reproduction of the live third-run audio path:
 *   espeak-ng 22050 Hz mono
 *     -> decodeAudioData upsample to the page AudioContext rate (44100)
 *     -> pcm16Base64FromFloat32(input, 44100, 16000)  [current source]
 *     -> realtimeInput.audio  (audio/pcm;rate=16000)
 *
 * Nothing here calls a provider. The legacy control reproduces the unfiltered
 * point decimator from before PR #155; the current path must preserve speech
 * while reducing that control's upper-band aliasing. This is an offline signal
 * check, not evidence about a provider's input transcription.
 */

const SOURCE_RATE = 22_050
const CONTEXT_RATE = 44_100
const TARGET_RATE = 16_000

function decodeBase64Pcm16(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64')
  const out = new Float32Array(bytes.byteLength / 2)
  for (let index = 0; index < out.length; index += 1) {
    const value = bytes.readInt16LE(index * 2)
    out[index] = value < 0 ? value / 0x8000 : value / 0x7fff
  }
  return out
}

/** Band-limited 2x upsample, which is what decodeAudioData performs for a
 * 22050 Hz asset into a 44100 Hz context. Zero-stuff then low-pass at the
 * source Nyquist with a windowed sinc. */
function upsample2x(input: Float32Array): Float32Array {
  const out = new Float32Array(input.length * 2)
  const half = 32
  const taps: number[] = []
  for (let n = -half; n <= half; n += 1) {
    const x = n / 2
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    taps.push(sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * (n + half)) / (2 * half))))
  }
  for (let i = 0; i < out.length; i += 1) {
    let acc = 0
    for (let n = -half; n <= half; n += 1) {
      const src = i + n
      if (src % 2 !== 0) continue
      const idx = src / 2
      if (idx < 0 || idx >= input.length) continue
      acc += input[idx]! * taps[n + half]!
    }
    out[i] = acc
  }
  return out
}

/** Reference: properly band-limited decimation to 16 kHz (anti-aliased). */
function referenceResample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  const half = 24
  for (let i = 0; i < length; i += 1) {
    const center = i * ratio
    let acc = 0
    let norm = 0
    for (let n = -half; n <= half; n += 1) {
      const idx = Math.round(center) + n
      if (idx < 0 || idx >= input.length) continue
      const x = (idx - center) / ratio
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * (n + half)) / (2 * half))
      acc += input[idx]! * sinc * w
      norm += sinc * w
    }
    out[i] = norm === 0 ? 0 : acc / norm
  }
  return out
}

/** Goertzel band energy, in the sampled signal's own rate. */
function bandEnergy(signal: Float32Array, rate: number, low: number, high: number): number {
  let total = 0
  const step = 50
  for (let f = low; f <= high; f += step) {
    const w = (2 * Math.PI * f) / rate
    const coeff = 2 * Math.cos(w)
    let s1 = 0
    let s2 = 0
    for (const sample of signal) {
      const s0 = sample + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    total += s1 * s1 + s2 * s2 - coeff * s1 * s2
  }
  return total
}

/** Speech-like 22050 Hz mono: voiced formants plus a fricative band that only
 * a 22050 Hz source can carry (8-11 kHz), which is the band at issue. */
function syntheticUtterance(seconds: number, withFricative: boolean): Float32Array {
  const length = Math.floor(SOURCE_RATE * seconds)
  const out = new Float32Array(length)
  let seed = 12345
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5 }
  for (let i = 0; i < length; i += 1) {
    const t = i / SOURCE_RATE
    const f0 = 120 + 10 * Math.sin(2 * Math.PI * 3 * t)
    let sample = 0
    for (const [formant, gain] of [[700, 0.5], [1220, 0.3], [2600, 0.15]] as const) {
      sample += gain * Math.sin(2 * Math.PI * formant * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * f0 * t))
    }
    if (withFricative && i % SOURCE_RATE > SOURCE_RATE * 0.6) {
      // Narrow high band around 9.5 kHz, as in a sibilant.
      sample += 0.35 * rand() * Math.sin(2 * Math.PI * 9_500 * t)
    }
    out[i] = Math.max(-1, Math.min(1, sample * 0.6))
  }
  return out
}

function runDeployedPath(source: Float32Array) {
  const context = upsample2x(source)
  const produced = decodeBase64Pcm16(pcm16Base64FromFloat32(context, CONTEXT_RATE, TARGET_RATE))
  const reference = referenceResample(context, CONTEXT_RATE, TARGET_RATE)
  return { context, produced, reference }
}

/** Historical control: the point decimator used before PR #155, including PCM quantization. */
function legacyPointDecimate(input: Float32Array): Float32Array {
  const ratio = CONTEXT_RATE / TARGET_RATE
  const pcm = new Int16Array(Math.floor(input.length / ratio))
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[Math.floor(index * ratio)] ?? 0))
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return decodeBase64Pcm16(Buffer.from(pcm.buffer).toString('base64'))
}

describe('espeak 22050 -> 44100 -> 16000 deployed path', () => {
  it('produces the expected frame geometry and non-trivial amplitude', () => {
    const { context, produced } = runDeployedPath(syntheticUtterance(1, true))
    expect(context.length).toBe(SOURCE_RATE * 2)
    // 4096-sample context buffers decimate to 1486 samples = 2972 bytes, which
    // is exactly the frame size observed in the live run.
    expect(Math.floor(4096 / (CONTEXT_RATE / TARGET_RATE))).toBe(1486)
    const peak = produced.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    expect(peak).toBeGreaterThan(0.2)
  })

  it('preserves speech and reduces upper-band aliasing relative to the legacy decimator', () => {
    const { context, produced, reference } = runDeployedPath(syntheticUtterance(1, true))
    const legacy = legacyPointDecimate(context)
    const speechProduced = bandEnergy(produced, TARGET_RATE, 300, 3_400)
    const speechReference = bandEnergy(reference, TARGET_RATE, 300, 3_400)
    const upperProduced = bandEnergy(produced, TARGET_RATE, 5_000, 7_900)
    const upperReference = bandEnergy(reference, TARGET_RATE, 5_000, 7_900)
    const speechLegacy = bandEnergy(legacy, TARGET_RATE, 300, 3_400)
    const upperLegacy = bandEnergy(legacy, TARGET_RATE, 5_000, 7_900)

    const speechRatioDb = 10 * Math.log10(speechProduced / speechReference)
    const upperRatioDb = 10 * Math.log10(upperProduced / Math.max(upperReference, 1e-12))
    const legacySpeechRatioDb = 10 * Math.log10(speechLegacy / speechReference)
    const legacyUpperRatioDb = 10 * Math.log10(upperLegacy / Math.max(upperReference, 1e-12))
    const upperReductionDb = 10 * Math.log10(upperLegacy / upperProduced)
    // eslint-disable-next-line no-console
    console.log(`speech-band delta ${speechRatioDb.toFixed(2)} dB, 5-8 kHz delta ${upperRatioDb.toFixed(2)} dB, reduction from legacy ${upperReductionDb.toFixed(2)} dB`)

    // The core speech band is preserved: a 22050 Hz source is already limited
    // to 11.025 kHz. The historical control folds that content to
    // |16000 - f| = 4975..8000 Hz; PR #155 filters it before decimation.
    // Retain the old measurement as a positive control, then require the
    // current path to reduce upper-band energy by at least 3 dB (half).
    expect(Math.abs(speechRatioDb)).toBeLessThan(3)
    expect(legacyUpperRatioDb).toBeGreaterThan(legacySpeechRatioDb)
    expect(upperReductionDb).toBeGreaterThan(3)
  })

  it('MEASURE: no fricative content means no meaningful added distortion', () => {
    const { produced, reference } = runDeployedPath(syntheticUtterance(1, false))
    const speechProduced = bandEnergy(produced, TARGET_RATE, 300, 3_400)
    const speechReference = bandEnergy(reference, TARGET_RATE, 300, 3_400)
    const db = 10 * Math.log10(speechProduced / speechReference)
    // eslint-disable-next-line no-console
    console.log(`no-fricative speech-band delta ${db.toFixed(2)} dB`)
    expect(Math.abs(db)).toBeLessThan(3)
  })

  it('MEASURE: the produced stream is audibly non-silent throughout', () => {
    const { produced } = runDeployedPath(syntheticUtterance(1, true))
    let rms = 0
    for (const sample of produced) rms += sample * sample
    rms = Math.sqrt(rms / produced.length)
    // eslint-disable-next-line no-console
    console.log(`produced RMS ${rms.toFixed(4)} (${(20 * Math.log10(rms)).toFixed(1)} dBFS)`)
    expect(rms).toBeGreaterThan(0.02)
  })
})
