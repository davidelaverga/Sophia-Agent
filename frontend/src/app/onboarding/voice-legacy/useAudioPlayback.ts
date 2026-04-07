/**
 * Hook for managing audio playback with real-time PCM streaming
 * 
 * Optimized for Cartesia WebSocket TTS:
 * - Float32 PCM at 44100Hz (pcm_f32le)
 * - Real-time streaming playback (no buffering delays)
 * - Gapless audio scheduling using Web Audio API
 */

import { useRef, useCallback, useEffect } from "react"

import { PREBUFFER_CHUNKS, FIRST_AUDIO_TARGET_MS, base64ToUint8Array } from "../../hooks/voice/voice-utils"
import { isVerboseDebugEnabled } from "../../lib/debug"
import { debugLog, debugWarn } from "../../lib/debug-logger"
import { logger } from "../../lib/error-logger"
import { emitTelemetry } from "../../lib/telemetry"
import type { QueuedChunk, RouterPath } from "../../lib/voice-types"

type UseAudioPlaybackProps = {
  path?: RouterPath
  onPlaybackComplete?: () => void
}

// Audio format constants from Cartesia
const CARTESIA_SAMPLE_RATE = 44100
const BYTES_PER_SAMPLE = 4  // float32
const NUM_CHANNELS = 1

export function useAudioPlayback({ path, onPlaybackComplete }: UseAudioPlaybackProps = {}) {
  // Legacy queue-based playback refs
  const playbackQueueRef = useRef<QueuedChunk[]>([])
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const isPlayingRef = useRef(false)
  const hasStartedPlaybackRef = useRef(false)
  const prebufferOverrideRef = useRef(false)
  const streamEndedRef = useRef(false)
  const firstChunkAtRef = useRef<number | null>(null)
  
  // Real-time PCM streaming refs
  const audioContextRef = useRef<AudioContext | null>(null)
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const nextPlayTimeRef = useRef(0)
  const totalChunksPlayedRef = useRef(0)
  const isStreamingRef = useRef(false)
  const streamStartTimeRef = useRef(0)
  const firstChunkReceivedRef = useRef(0)
  const chunkIndexRef = useRef(0)

  // =========================================================================
  // Cleanup AudioContext on unmount to prevent memory leaks
  // =========================================================================
  
  useEffect(() => {
    return () => {
      // Stop all active sources
      activeSourcesRef.current.forEach(source => {
        try { source.stop() } catch { /* ignore */ }
      })
      activeSourcesRef.current = []
      
      // Close AudioContext to release system resources
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        try {
          void audioContextRef.current.close().catch(() => {
            // Ignore close errors
          })
        } catch {
          // Ignore close errors
        }
        if (isVerboseDebugEnabled()) {
          debugLog("AudioPlayback", "AudioContext closed on unmount")
        }
      }
      audioContextRef.current = null
    }
  }, [])

  // =========================================================================
  // Initialize AudioContext (matches Cartesia sample rate)
  // =========================================================================
  
  const initAudioContext = useCallback(async (): Promise<AudioContext> => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextClass) {
        throw new Error("AudioContext is not supported in this browser")
      }
      audioContextRef.current = new AudioContextClass({
        sampleRate: CARTESIA_SAMPLE_RATE,
      })
      debugLog("AudioPlayback", `AudioContext created @ ${audioContextRef.current.sampleRate}Hz`)
    }
    
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume()
      debugLog("AudioPlayback", "AudioContext resumed")
    }
    
    return audioContextRef.current
  }, [])

  // =========================================================================
  // REAL-TIME: Play Float32 PCM chunk IMMEDIATELY (no buffering)
  // =========================================================================
  
  const playFloat32ChunkImmediately = useCallback(async (pcmData: Uint8Array, chunkIndex: number) => {
    try {
      const audioContext = audioContextRef.current
      if (!audioContext) {
        debugWarn("AudioPlayback", `Chunk ${chunkIndex}: No AudioContext`)
        return
      }
      
      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }
      
      // Ensure we have complete float32 samples (4 bytes each)
      const validLength = pcmData.length - (pcmData.length % BYTES_PER_SAMPLE)
      if (validLength === 0) {
        return // Skip empty chunks silently
      }
      
      const numSamples = validLength / BYTES_PER_SAMPLE
      
      // Create AudioBuffer
      const audioBuffer = audioContext.createBuffer(NUM_CHANNELS, numSamples, CARTESIA_SAMPLE_RATE)
      const channelData = audioBuffer.getChannelData(0)
      
      // Convert bytes to Float32 - pcm_f32le is native JavaScript format
      const dataView = new DataView(pcmData.buffer, pcmData.byteOffset, validLength)
      for (let i = 0; i < numSamples; i++) {
        channelData[i] = dataView.getFloat32(i * BYTES_PER_SAMPLE, true) // little-endian
      }
      
      // Create source and connect
      const source = audioContext.createBufferSource()
      source.buffer = audioBuffer
      source.connect(audioContext.destination)
      
      const currentTime = audioContext.currentTime
      
      // FIRST CHUNK: Start immediately with tiny buffer
      if (chunkIndex === 1) {
        nextPlayTimeRef.current = currentTime + 0.01 // 10ms buffer only
        const latency = performance.now() - firstChunkReceivedRef.current
        if (isVerboseDebugEnabled()) {
          debugLog("AudioPlayback", `▶️ PLAY START! Chunk 1 (${numSamples} samples, ${latency.toFixed(0)}ms since received)`)
        }
      }
      
      // Schedule this chunk for gapless playback
      const startTime = Math.max(currentTime + 0.001, nextPlayTimeRef.current)
      source.start(startTime)
      
      // Calculate next play time for gapless playback
      nextPlayTimeRef.current = startTime + audioBuffer.duration
      
      // Track active sources
      activeSourcesRef.current.push(source)
      totalChunksPlayedRef.current++
      
      // Log every 10 chunks
      if (chunkIndex % 10 === 0) {
        if (isVerboseDebugEnabled()) {
          debugLog("AudioPlayback", `🔊 Chunk ${chunkIndex} scheduled @ ${startTime.toFixed(3)}s`)
        }
      }
      
      source.onended = () => {
        const idx = activeSourcesRef.current.indexOf(source)
        if (idx > -1) activeSourcesRef.current.splice(idx, 1)
        
        // Check if all done
        if (!isStreamingRef.current && activeSourcesRef.current.length === 0) {
          isPlayingRef.current = false
          const totalTime = ((performance.now() - streamStartTimeRef.current) / 1000).toFixed(2)
          if (isVerboseDebugEnabled()) {
            debugLog("AudioPlayback", `✅ Done! ${totalChunksPlayedRef.current} chunks in ${totalTime}s`)
          }
          onPlaybackComplete?.()
        }
      }
      
    } catch (err) {
      debugWarn("AudioPlayback", `Chunk ${chunkIndex} playback error`, { error: err })
    }
  }, [onPlaybackComplete])

  // =========================================================================
  // Stop all playback (barge-in support)
  // =========================================================================
  
  const stopPlayback = useCallback(() => {
    isStreamingRef.current = false
    
    activeSourcesRef.current.forEach(source => {
      try { source.stop() } catch { /* ignore */ }
    })
    activeSourcesRef.current = []
    
    nextPlayTimeRef.current = 0
    totalChunksPlayedRef.current = 0
    chunkIndexRef.current = 0
    isPlayingRef.current = false
  }, [])

  // =========================================================================
  // Legacy: Stop current audio playback (HTMLAudioElement)
  // =========================================================================
  
  const stopCurrentAudio = useCallback(() => {
    const current = currentAudioRef.current
    if (!current) return
    
    try {
      current.pause()
      current.currentTime = 0
    } catch { /* ignore */ }
    
    current.onended = null
    current.onerror = null
    current.onabort = null
    
    if (current.src?.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(current.src)
      } catch (err) {
        logger.warn("Failed to revoke blob URL in stopCurrentAudio", {
          context: "useAudioPlayback.stopCurrentAudio",
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    
    currentAudioRef.current = null
    isPlayingRef.current = false
  }, [])

  // =========================================================================
  // Flush entire playback queue and stop all audio
  // =========================================================================
  
  const flushPlaybackQueue = useCallback(() => {
    stopCurrentAudio()
    stopPlayback()
    
    for (const chunk of playbackQueueRef.current) {
      if (chunk.revokeOnUse) {
        try {
          URL.revokeObjectURL(chunk.url)
        } catch { /* ignore */ }
      }
    }
    
    playbackQueueRef.current = []
    hasStartedPlaybackRef.current = false
    prebufferOverrideRef.current = false
    streamEndedRef.current = false
    firstChunkAtRef.current = null
  }, [stopCurrentAudio, stopPlayback])

  // =========================================================================
  // Reset playback tracking
  // =========================================================================
  
  const resetPlaybackTracking = useCallback(() => {
    hasStartedPlaybackRef.current = false
    prebufferOverrideRef.current = false
    streamEndedRef.current = false
    firstChunkAtRef.current = null
  }, [])

  // =========================================================================
  // Legacy: Start next chunk if ready (for queue-based playback)
  // =========================================================================
  
  const startNextChunkIfReady = useCallback(() => {
    if (isPlayingRef.current || playbackQueueRef.current.length === 0) return

    const needsPrebuffer = !hasStartedPlaybackRef.current
    const prebufferReady =
      !needsPrebuffer || prebufferOverrideRef.current || playbackQueueRef.current.length >= PREBUFFER_CHUNKS
    if (!prebufferReady) return

    const nextChunk = playbackQueueRef.current.shift()
    if (!hasStartedPlaybackRef.current) {
      hasStartedPlaybackRef.current = true
      prebufferOverrideRef.current = false
      if (firstChunkAtRef.current) {
        const latency = performance.now() - firstChunkAtRef.current
        if (latency < FIRST_AUDIO_TARGET_MS) {
          emitTelemetry("voice.prebuffer_success", { latency_ms: Math.round(latency), path })
        }
      }
    }

    const audio = new Audio(nextChunk.url)
    audio.preload = "auto"
    currentAudioRef.current = audio
    isPlayingRef.current = true

    const finalize = () => {
      if (nextChunk.revokeOnUse && nextChunk.url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(nextChunk.url)
        } catch (err) {
          logger.warn("Failed to revoke blob URL after playback", {
            context: "useAudioPlayback.finalize",
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      stopCurrentAudio()
      
      if (playbackQueueRef.current.length > 0) {
        startNextChunkIfReady()
      } else if (streamEndedRef.current) {
        resetPlaybackTracking()
        onPlaybackComplete?.()
      }
    }

    audio.onended = finalize
    audio.onerror = finalize
    audio.onabort = finalize

    audio.play().catch(() => finalize())
  }, [path, stopCurrentAudio, resetPlaybackTracking, onPlaybackComplete])

  // =========================================================================
  // Enqueue methods (legacy support)
  // =========================================================================
  
  const enqueueChunk = useCallback((chunk: QueuedChunk) => {
    playbackQueueRef.current.push(chunk)
    if (!firstChunkAtRef.current) {
      firstChunkAtRef.current = performance.now()
    }
    startNextChunkIfReady()
  }, [startNextChunkIfReady])

  const enqueueBase64Chunk = useCallback((b64: string, mime?: string) => {
    try {
      const bytes = base64ToUint8Array(b64)
      const blob = new Blob([bytes as BlobPart], { type: mime || "audio/wav" })
      const url = URL.createObjectURL(blob)
      enqueueChunk({ url, revokeOnUse: true })
    } catch (err) {
      debugWarn("useAudioPlayback", "failed to enqueue base64 chunk", { error: err })
    }
  }, [enqueueChunk])

  const enqueueRemoteChunk = useCallback((url?: string) => {
    if (!url) return
    if (!/^(https?|blob):/.test(url)) return
    enqueueChunk({ url, revokeOnUse: url.startsWith("blob:") })
  }, [enqueueChunk])

  const enqueueBinaryAudio = useCallback((data: ArrayBuffer, mime = "audio/wav") => {
    try {
      const blob = new Blob([data], { type: mime })
      const url = URL.createObjectURL(blob)
      enqueueChunk({ url, revokeOnUse: true })
    } catch (err) {
      debugWarn("useAudioPlayback", "failed to enqueue binary audio", { error: err })
    }
  }, [enqueueChunk])

  // =========================================================================
  // REAL-TIME PCM STREAMING: Enqueue and play immediately
  // =========================================================================
  
  /**
   * Enqueue PCM float32 chunk and play IMMEDIATELY
   * This is the key function for real-time streaming
   */
  const enqueuePcmChunk = useCallback(async (data: ArrayBuffer) => {
    try {
      // Initialize on first chunk
      if (chunkIndexRef.current === 0) {
        await initAudioContext()
        isStreamingRef.current = true
        isPlayingRef.current = true
        streamStartTimeRef.current = performance.now()
        firstChunkReceivedRef.current = performance.now()
        nextPlayTimeRef.current = 0
        totalChunksPlayedRef.current = 0
        activeSourcesRef.current = []
      }
      
      chunkIndexRef.current++
      const bytes = new Uint8Array(data)
      
      // Play immediately - no buffering!
      await playFloat32ChunkImmediately(bytes, chunkIndexRef.current)
      
    } catch (err) {
      debugWarn("useAudioPlayback", "failed to enqueue PCM chunk", { error: err })
    }
  }, [initAudioContext, playFloat32ChunkImmediately])

  // =========================================================================
  // Mark stream as ended
  // =========================================================================
  
  const markStreamEnded = useCallback(() => {
    streamEndedRef.current = true
    prebufferOverrideRef.current = true
    isStreamingRef.current = false
    
    // Reset chunk counter for next stream
    chunkIndexRef.current = 0
    
    // If no active sources, complete immediately
    if (activeSourcesRef.current.length === 0 && !isPlayingRef.current) {
      resetPlaybackTracking()
      onPlaybackComplete?.()
    }
    // Otherwise, onended handlers will trigger completion
  }, [resetPlaybackTracking, onPlaybackComplete])

  // =========================================================================
  // Force start playback immediately (skip prebuffering)
  // =========================================================================
  
  const forcePrebufferOverride = useCallback(() => {
    prebufferOverrideRef.current = true
    startNextChunkIfReady()
  }, [startNextChunkIfReady])

  return {
    // Legacy queue-based methods
    enqueueBase64Chunk,
    enqueueRemoteChunk,
    enqueueBinaryAudio,
    
    // Real-time PCM streaming (preferred)
    enqueuePcmChunk,
    initAudioContext,
    stopPlayback,
    
    // Common methods
    flushPlaybackQueue,
    markStreamEnded,
    forcePrebufferOverride,
    isPlaying: isPlayingRef.current,
  }
}