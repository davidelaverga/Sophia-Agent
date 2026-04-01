"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAudioPlayback } from '../voice-legacy/useAudioPlayback'
import { buildSpeakTextCommand } from '../voice-legacy/voice-loop-command-helpers'
import {
  connectVoiceSessionFreshSafely,
  generateVoiceSessionId,
  resolveVoiceWsBaseUrl,
} from '../voice-legacy/voice-loop-connection-helpers'
import { base64ToUint8Array } from '../../hooks/voice/voice-utils'
import { useVoiceWebSocket } from '../voice-legacy/useVoiceWebSocket'
import { useOnboardingStore } from '../../stores/onboarding-store'
import { getOnboardingVoiceOnlineState, shouldEnableOnboardingVoice } from '../voice'

type UseOnboardingVoiceResult = {
  canPlayVoiceOver: boolean
  isPlaying: boolean
  voiceOverEnabled: boolean
  setVoiceOverEnabled: (enabled: boolean) => void
  toggleVoiceOver: () => void
  speak: (line: string | null | undefined) => Promise<boolean>
  stop: () => void
}

export function useOnboardingVoice(reducedMotion: boolean): UseOnboardingVoiceResult {
  const voiceOverEnabled = useOnboardingStore((state) => state.preferences.voiceOverEnabled)
  const setStoredVoiceOverEnabled = useOnboardingStore((state) => state.setVoiceOverEnabled)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false)
  const { connect, sendText, disconnect } = useVoiceWebSocket()
  const stopRef = useRef<() => void>(() => undefined)
  const unlockAttemptedRef = useRef(false)
  const handlePlaybackComplete = useCallback(() => {
    disconnect()
    setIsPlaying(false)
    setIsConnecting(false)
  }, [disconnect])
  const playback = useAudioPlayback({
    path: 'direct',
    onPlaybackComplete: handlePlaybackComplete,
  })
  const {
    enqueuePcmChunk,
    flushPlaybackQueue,
    forcePrebufferOverride,
    markStreamEnded,
    stopPlayback,
  } = playback

  const stop = useCallback(() => {
    disconnect()
    flushPlaybackQueue()
    stopPlayback()
    setIsPlaying(false)
    setIsConnecting(false)
  }, [disconnect, flushPlaybackQueue, stopPlayback])

  stopRef.current = stop

  useEffect(() => stop, [stop])

  useEffect(() => {
    if (typeof window === 'undefined' || isAudioUnlocked) {
      return undefined
    }

    const unlockAudio = () => {
      if (unlockAttemptedRef.current) {
        return
      }

      unlockAttemptedRef.current = true

      void playback.initAudioContext()
        .then(() => {
          setIsAudioUnlocked(true)
        })
        .catch(() => {
          unlockAttemptedRef.current = false
        })
    }

    const options: AddEventListenerOptions = { capture: true, passive: true }

    window.addEventListener('pointerdown', unlockAudio, options)
    window.addEventListener('touchstart', unlockAudio, options)
    window.addEventListener('keydown', unlockAudio, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', unlockAudio, options)
      window.removeEventListener('touchstart', unlockAudio, options)
      window.removeEventListener('keydown', unlockAudio, { capture: true })
    }
  }, [isAudioUnlocked, playback])

  const canPlayVoiceOver = useMemo(() => shouldEnableOnboardingVoice({
    hasVoiceLine: true,
    voiceOverEnabled,
    reducedMotion,
    isOnline: getOnboardingVoiceOnlineState(),
  }), [reducedMotion, voiceOverEnabled])

  const setVoiceOverEnabled = useCallback((enabled: boolean) => {
    setStoredVoiceOverEnabled(enabled)
    if (!enabled) {
      stop()
    }
  }, [setStoredVoiceOverEnabled, stop])

  const toggleVoiceOver = useCallback(() => {
    setVoiceOverEnabled(!voiceOverEnabled)
  }, [setVoiceOverEnabled, voiceOverEnabled])

  const speak = useCallback(async (line: string | null | undefined) => {
    stop()

    const normalizedLine = line?.trim()
    const isEligible = shouldEnableOnboardingVoice({
      hasVoiceLine: Boolean(normalizedLine),
      voiceOverEnabled,
      reducedMotion,
      isOnline: getOnboardingVoiceOnlineState(),
    })

    if (!normalizedLine || !isEligible || !isAudioUnlocked) {
      return false
    }

    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      return false
    }

    try {
      setIsConnecting(true)

      const wsHandlers = {
        onClose: () => {
          setIsConnecting(false)
          setIsPlaying(false)
        },
        onError: () => {
          stopRef.current()
        },
        onBinaryMessage: (data: ArrayBuffer) => {
          setIsPlaying(true)
          setIsConnecting(false)
          void enqueuePcmChunk(data)
        },
        onMessage: (message: { type: string; audio_base64?: string; b64?: string }) => {
          if (message.type === 'audio_chunk') {
            const encodedAudio = message.audio_base64 ?? message.b64
            if (!encodedAudio) {
              return
            }

            setIsPlaying(true)
            setIsConnecting(false)
            const decodedBuffer = base64ToUint8Array(encodedAudio).buffer
            void enqueuePcmChunk(decodedBuffer)
            return
          }

          if (message.type === 'response_end') {
            forcePrebufferOverride()
            markStreamEnded()
            return
          }

          if (message.type === 'error') {
            stopRef.current()
          }
        },
      }

      const connectionAttempt = await connectVoiceSessionFreshSafely({
        disconnect,
        connect,
        baseUrl: resolveVoiceWsBaseUrl(),
        sessionId: generateVoiceSessionId(),
        handlers: wsHandlers,
        useSingleRetry: true,
      })

      if (!connectionAttempt.result) {
        setIsConnecting(false)
        return false
      }

      const traceId = `onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const sent = sendText(buildSpeakTextCommand(normalizedLine, traceId))
      if (!sent) {
        stop()
        return false
      }

      return true
    } catch {
      stop()
      return false
    }
  }, [connect, disconnect, enqueuePcmChunk, forcePrebufferOverride, isAudioUnlocked, markStreamEnded, reducedMotion, sendText, stop, voiceOverEnabled])

  return {
    canPlayVoiceOver,
    isPlaying: isPlaying || isConnecting,
    voiceOverEnabled,
    setVoiceOverEnabled,
    toggleVoiceOver,
    speak,
    stop,
  }
}