/**
 * Utility functions for voice processing
 */

export const PREBUFFER_CHUNKS = 3
export const FIRST_AUDIO_TARGET_MS = 200

export type VoiceStage = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error"
export type RouterPath = "direct" | "light" | "agentic"

/**
 * Common voice state shape consumed by VoicePanel, VoiceFocusView, etc.
 * Both VoiceLoopReturn and StreamVoiceSessionReturn satisfy this interface.
 */
export type VoiceStateProps = {
  stage: VoiceStage
  partialReply: string
  finalReply: string
  error?: string
  stream?: MediaStream | null
  needsUnlock?: boolean
  path?: RouterPath
  startTalking?: () => Promise<void>
  stopTalking: () => Promise<void> | void
  bargeIn: () => void
  unlockAudio?: () => void
  resetVoiceState?: () => void
}

export type QueuedChunk = {
  url: string
  revokeOnUse: boolean
}

/**
 * Convert HTTP/HTTPS URL to WebSocket URL
 */
export const httpToWs = (url: string): string => {
  if (url.startsWith("https://")) return url.replace("https://", "wss://")
  if (url.startsWith("http://")) return url.replace("http://", "ws://")
  return url
}

/**
 * Convert base64 string to Uint8Array
 */
export const base64ToUint8Array = (b64: string): Uint8Array => {
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i)
  }
  return bytes
}

/**
 * Get AudioContext constructor (with webkit fallback)
 */
export const getAudioContextClass = (): typeof AudioContext => {
  if (typeof window === "undefined") {
    throw new Error("AudioContext unavailable")
  }
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & {
      webkitAudioContext?: typeof AudioContext
    }).webkitAudioContext
  if (!AudioContextClass) {
    throw new Error("AudioContext not supported")
  }
  return AudioContextClass
}

/**
 * Downsample audio to 16kHz PCM16
 */
export function downsampleTo16kPCM(input: Float32Array, inputSampleRate: number): ArrayBuffer {
  const targetRate = 16000
  if (inputSampleRate === targetRate) {
    const pcm = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return pcm.buffer
  }
  const ratio = inputSampleRate / targetRate
  const newLength = Math.floor(input.length / ratio)
  const result = new Float32Array(newLength)
  let pos = 0
  let idx = 0
  while (pos < newLength) {
    const nextIdx = Math.floor((pos + 1) * ratio)
    let sum = 0
    let count = 0
    for (let i = idx; i < nextIdx && i < input.length; i += 1) {
      sum += input[i]
      count += 1
    }
    result[pos] = sum / (count || 1)
    pos += 1
    idx = nextIdx
  }
  const pcm = new Int16Array(result.length)
  for (let i = 0; i < result.length; i += 1) {
    const s = Math.max(-1, Math.min(1, result[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm.buffer
}

/**
 * Create WAV file from PCM16 data
 * @param pcm16Data - PCM16 audio data (Int16Array or ArrayBuffer)
 * @param sampleRate - Sample rate (default 16000)
 * @returns ArrayBuffer containing complete WAV file
 */
export function createWavFromPcm16(pcm16Data: ArrayBuffer | Int16Array, sampleRate = 16000): ArrayBuffer {
  const pcmBuffer = pcm16Data instanceof Int16Array ? pcm16Data.buffer : pcm16Data
  const pcmBytes = new Uint8Array(pcmBuffer)
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  
  // WAV header is 44 bytes
  const wavBuffer = new ArrayBuffer(44 + pcmBytes.length)
  const view = new DataView(wavBuffer)
  
  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcmBytes.length, true) // file size - 8
  writeString(view, 8, 'WAVE')
  
  // fmt sub-chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // subchunk1 size (16 for PCM)
  view.setUint16(20, 1, true) // audio format (1 = PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  
  // data sub-chunk
  writeString(view, 36, 'data')
  view.setUint32(40, pcmBytes.length, true)
  
  // Write PCM data
  const wavBytes = new Uint8Array(wavBuffer)
  wavBytes.set(pcmBytes, 44)
  
  return wavBuffer
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
