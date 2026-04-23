"use client"

import {
  StreamVideoClient,
  type Call,
  type User,
  CallingState,
} from "@stream-io/video-react-sdk"
import { useCallback, useEffect, useRef, useState } from "react"

import { logger } from "../lib/error-logger"
import { recordSophiaCaptureEvent, recordSophiaCaptureWebRTCStats } from "../lib/session-capture"

function describeMediaReadyState(value: number): string {
  switch (value) {
    case HTMLMediaElement.HAVE_NOTHING:
      return "have_nothing"
    case HTMLMediaElement.HAVE_METADATA:
      return "have_metadata"
    case HTMLMediaElement.HAVE_CURRENT_DATA:
      return "have_current_data"
    case HTMLMediaElement.HAVE_FUTURE_DATA:
      return "have_future_data"
    case HTMLMediaElement.HAVE_ENOUGH_DATA:
      return "have_enough_data"
    default:
      return `unknown:${value}`
  }
}

function describeMediaNetworkState(value: number): string {
  switch (value) {
    case HTMLMediaElement.NETWORK_EMPTY:
      return "network_empty"
    case HTMLMediaElement.NETWORK_IDLE:
      return "network_idle"
    case HTMLMediaElement.NETWORK_LOADING:
      return "network_loading"
    case HTMLMediaElement.NETWORK_NO_SOURCE:
      return "network_no_source"
    default:
      return `unknown:${value}`
  }
}

function describeMediaError(error: MediaError | null): string | null {
  if (!error) {
    return null
  }

  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "aborted"
    case MediaError.MEDIA_ERR_NETWORK:
      return "network"
    case MediaError.MEDIA_ERR_DECODE:
      return "decode"
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "src_not_supported"
    default:
      return error.message || `unknown:${error.code}`
  }
}

function buildRemoteAudioPayload(audioEl: HTMLAudioElement) {
  return {
    autoplay: audioEl.autoplay,
    currentTimeMs: Number.isFinite(audioEl.currentTime)
      ? Math.round(audioEl.currentTime * 1000)
      : null,
    ended: audioEl.ended,
    muted: audioEl.muted,
    networkState: describeMediaNetworkState(audioEl.networkState),
    paused: audioEl.paused,
    readyState: describeMediaReadyState(audioEl.readyState),
  }
}

function subscribeToWebRTCStats(
  call: Call,
  metadata: {
    callId: string | null
    callType: string | null
    voiceAgentSessionId: string | null
  },
): () => void {
  const subscription = call.state.callStatsReport$.subscribe({
    next: (report) => {
      recordSophiaCaptureWebRTCStats({
        callId: metadata.callId,
        voiceAgentSessionId: metadata.voiceAgentSessionId,
        report,
      })
    },
    error: (error) => {
      recordSophiaCaptureEvent({
        category: "voice-runtime",
        name: "webrtc-stats-error",
        payload: {
          callId: metadata.callId,
          callType: metadata.callType,
          error: error instanceof Error ? error.message : String(error),
          voiceAgentSessionId: metadata.voiceAgentSessionId,
        },
      })
    },
  })

  return () => {
    subscription.unsubscribe()
  }
}

/**
 * Binds audio elements for remote participants using the SDK's own
 * call.bindAudioElement() API so the AudioBindingsWatchdog is satisfied.
 * Returns a cleanup function.
 */
function bindRemoteAudio(
  call: Call,
  metadata: {
    callId: string | null
    callType: string | null
    voiceAgentSessionId: string | null
  },
): () => void {
  const boundElements = new Map<string, {
    el: HTMLAudioElement
    cleanup: (() => void) | undefined
    removeListeners: () => void
    playbackTimeoutId: number | null
  }>()

  const recordRemoteAudioEvent = (name: string, payload: Record<string, unknown>) => {
    recordSophiaCaptureEvent({
      category: "voice-runtime",
      name,
      payload: {
        callId: metadata.callId,
        callType: metadata.callType,
        voiceAgentSessionId: metadata.voiceAgentSessionId,
        ...payload,
      },
    })
  }

  const sub = call.state.remoteParticipants$.subscribe((participants) => {
    const currentSessionIds = new Set(participants.map((p) => p.sessionId))

    // Remove elements for participants who left
    for (const [sessionId, entry] of boundElements) {
      if (!currentSessionIds.has(sessionId)) {
        if (entry.playbackTimeoutId !== null) {
          window.clearTimeout(entry.playbackTimeoutId)
        }
        entry.removeListeners()
        entry.cleanup?.()
        entry.el.remove()
        boundElements.delete(sessionId)
      }
    }

    // Add elements for new participants
    for (const p of participants) {
      if (!boundElements.has(p.sessionId)) {
        const boundAtMs = Date.now()
        const audioEl = document.createElement("audio")
        audioEl.autoplay = true
        audioEl.style.display = "none"
        audioEl.dataset.sophiaRemote = "true"
        document.body.appendChild(audioEl)

        let hasRecordedCanPlay = false
        let hasRecordedPlaying = false

        const emitPlaybackEvent = (name: string, payload: Record<string, unknown> = {}) => {
          recordRemoteAudioEvent(name, {
            participantSessionId: p.sessionId,
            ...buildRemoteAudioPayload(audioEl),
            ...payload,
          })
        }

        const handleCanPlay = () => {
          if (hasRecordedCanPlay) {
            return
          }

          hasRecordedCanPlay = true
          emitPlaybackEvent("remote-audio-canplay", {
            durationMs: Date.now() - boundAtMs,
          })
        }

        const handlePlaying = () => {
          if (hasRecordedPlaying) {
            return
          }

          hasRecordedPlaying = true
          const entry = boundElements.get(p.sessionId)
          if (entry?.playbackTimeoutId !== null) {
            window.clearTimeout(entry.playbackTimeoutId)
            entry.playbackTimeoutId = null
          }

          emitPlaybackEvent("remote-audio-playing", {
            durationMs: Date.now() - boundAtMs,
          })
        }

        const handleWaiting = () => {
          emitPlaybackEvent("remote-audio-waiting", {
            durationMs: Date.now() - boundAtMs,
          })
        }

        const handleStalled = () => {
          emitPlaybackEvent("remote-audio-stalled", {
            durationMs: Date.now() - boundAtMs,
          })
        }

        const handleError = () => {
          emitPlaybackEvent("remote-audio-error", {
            durationMs: Date.now() - boundAtMs,
            error: describeMediaError(audioEl.error),
          })
        }

        audioEl.addEventListener("canplay", handleCanPlay)
        audioEl.addEventListener("playing", handlePlaying)
        audioEl.addEventListener("waiting", handleWaiting)
        audioEl.addEventListener("stalled", handleStalled)
        audioEl.addEventListener("error", handleError)

        const removeListeners = () => {
          audioEl.removeEventListener("canplay", handleCanPlay)
          audioEl.removeEventListener("playing", handlePlaying)
          audioEl.removeEventListener("waiting", handleWaiting)
          audioEl.removeEventListener("stalled", handleStalled)
          audioEl.removeEventListener("error", handleError)
        }

        let cleanup: (() => void) | undefined
        try {
          cleanup = call.bindAudioElement(audioEl, p.sessionId, "audioTrack")
        } catch (error) {
          removeListeners()
          audioEl.remove()
          emitPlaybackEvent("remote-audio-bind-failed", {
            durationMs: Date.now() - boundAtMs,
            error: error instanceof Error ? error.message : String(error),
          })
          continue
        }

        const playbackTimeoutId = window.setTimeout(() => {
          if (hasRecordedPlaying) {
            return
          }

          emitPlaybackEvent("remote-audio-playback-timeout", {
            durationMs: Date.now() - boundAtMs,
          })
        }, 2500)

        emitPlaybackEvent("remote-participant-audio-bound", {
          durationMs: 0,
        })

        boundElements.set(p.sessionId, {
          el: audioEl,
          cleanup,
          removeListeners,
          playbackTimeoutId,
        })
      }
    }
  })

  return () => {
    sub.unsubscribe()
    for (const [, entry] of boundElements) {
      if (entry.playbackTimeoutId !== null) {
        window.clearTimeout(entry.playbackTimeoutId)
      }
      entry.removeListeners()
      entry.cleanup?.()
      entry.el.remove()
    }
    boundElements.clear()
  }
}

export type StreamVoiceCredentials = {
  apiKey: string
  token: string
  callType: string
  callId: string
  sessionId?: string | null
  threadId?: string | null
  streamUrl?: string | null
}

export type UseStreamVoiceOptions = {
  userId: string
  credentials: StreamVoiceCredentials | null
}

export type UseStreamVoiceReturn = {
  client: StreamVideoClient | null
  call: Call | null
  callingState: CallingState
  error: string | null
  remoteParticipantSessionIds: string[]
  join: () => Promise<void>
  leave: () => Promise<void>
}

/**
 * Low-level hook managing a Stream Video client and call lifecycle.
 * Handles client creation, call join/leave, and cleanup on unmount.
 */
export function useStreamVoice({
  userId,
  credentials,
}: UseStreamVoiceOptions): UseStreamVoiceReturn {
  const [callingState, setCallingState] = useState<CallingState>(CallingState.IDLE)
  const [error, setError] = useState<string | null>(null)
  const [remoteParticipantSessionIds, setRemoteParticipantSessionIds] = useState<string[]>([])
  const [client, setClient] = useState<StreamVideoClient | null>(null)
  const [call, setCall] = useState<Call | null>(null)
  const clientRef = useRef<StreamVideoClient | null>(null)
  const callRef = useRef<Call | null>(null)
  const joiningRef = useRef(false)
  const audioCleanupRef = useRef<(() => void) | null>(null)

  // Initialize client when credentials arrive
  useEffect(() => {
    if (!credentials) return

    logger.debug("StreamVoice", "Creating client", {
      userId,
      callId: credentials.callId,
    })
    const user: User = { id: userId, type: "authenticated" }
    const streamClient = new StreamVideoClient({
      apiKey: credentials.apiKey,
      user,
      token: credentials.token,
      options: {
        devicePersistence: { enabled: false },
      },
    })
    recordSophiaCaptureEvent({
      category: "voice-runtime",
      name: "client-created",
      payload: {
        callId: credentials.callId,
        callType: credentials.callType,
        threadId: credentials.threadId ?? null,
        voiceAgentSessionId: credentials.sessionId ?? null,
      },
    })
    clientRef.current = streamClient
    setClient(streamClient)

    const streamCall = streamClient.call(credentials.callType, credentials.callId)
    recordSophiaCaptureEvent({
      category: "voice-runtime",
      name: "call-instantiated",
      payload: {
        callId: credentials.callId,
        callType: credentials.callType,
        threadId: credentials.threadId ?? null,
        voiceAgentSessionId: credentials.sessionId ?? null,
      },
    })
    callRef.current = streamCall
    setCall(streamCall)

    const statsCleanup = subscribeToWebRTCStats(streamCall, {
      callId: credentials.callId,
      callType: credentials.callType,
      voiceAgentSessionId: credentials.sessionId ?? null,
    })

    // Subscribe to calling state changes
    const unsubscribe = streamCall.state.callingState$.subscribe((state) => {
      setCallingState(state)
    })

    const remoteParticipantsSubscription = streamCall.state.remoteParticipants$.subscribe((participants) => {
      setRemoteParticipantSessionIds(participants.map((participant) => participant.sessionId))
    })

    return () => {
      statsCleanup()
      unsubscribe.unsubscribe()
      remoteParticipantsSubscription.unsubscribe()
      audioCleanupRef.current?.()
      audioCleanupRef.current = null
      streamCall.leave().catch(() => {})
      streamClient.disconnectUser().catch(() => {})
      clientRef.current = null
      callRef.current = null
      setRemoteParticipantSessionIds([])
      setClient(null)
      setCall(null)
      setCallingState(CallingState.IDLE)
    }
  }, [userId, credentials])

  const join = useCallback(async () => {
    const call = callRef.current
    if (!call || joiningRef.current) return

    joiningRef.current = true
    setError(null)

    try {
      logger.debug("StreamVoice", "Starting join")
      recordSophiaCaptureEvent({
        category: "voice-runtime",
        name: "call-join-requested",
        payload: {
          callId: credentials?.callId ?? null,
          callType: credentials?.callType ?? null,
          voiceAgentSessionId: credentials?.sessionId ?? null,
        },
      })
      // Join with local media disabled so the SDK does not auto-apply stale
      // device preferences or mic defaults before we are ready.
      await call.camera.disable()
      await call.microphone.disableSpeakingWhileMutedNotification()
      await call.microphone.disable()

      logger.debug("StreamVoice", "Joining call", { create: true })
      await call.join({ create: true })
      logger.debug("StreamVoice", "Join succeeded", {
        callingState: String(call.state.callingState),
      })
      recordSophiaCaptureEvent({
        category: "voice-runtime",
        name: "call-joined",
        payload: {
          callId: credentials?.callId ?? null,
          callType: credentials?.callType ?? null,
          callingState: String(call.state.callingState),
          voiceAgentSessionId: credentials?.sessionId ?? null,
        },
      })

      // Bind remote audio since we're outside <StreamCall> context
      audioCleanupRef.current?.()
      audioCleanupRef.current = bindRemoteAudio(call, {
        callId: credentials?.callId ?? null,
        callType: credentials?.callType ?? null,
        voiceAgentSessionId: credentials?.sessionId ?? null,
      })
      logger.debug("StreamVoice", "Remote audio bound")
      recordSophiaCaptureEvent({
        category: "voice-runtime",
        name: "remote-audio-bound",
        payload: {
          callId: credentials?.callId ?? null,
          voiceAgentSessionId: credentials?.sessionId ?? null,
        },
      })

      try {
        await call.microphone.enable()
        recordSophiaCaptureEvent({
          category: "voice-runtime",
          name: "microphone-enabled",
          payload: {
            callId: credentials?.callId ?? null,
            voiceAgentSessionId: credentials?.sessionId ?? null,
          },
        })
      } catch (err) {
        logger.logError(err, {
          component: "useStreamVoice",
          action: "enable-microphone",
        })
        const message = err instanceof Error ? err.message : "Failed to enable microphone"
        recordSophiaCaptureEvent({
          category: "voice-runtime",
          name: "microphone-enable-failed",
          payload: {
            callId: credentials?.callId ?? null,
            error: message,
            voiceAgentSessionId: credentials?.sessionId ?? null,
          },
        })
        setError(message)
      }
    } catch (err) {
      logger.logError(err, {
        component: "useStreamVoice",
        action: "join",
      })
      const message = err instanceof Error ? err.message : "Failed to join call"
      recordSophiaCaptureEvent({
        category: "voice-runtime",
        name: "call-join-failed",
        payload: {
          callId: credentials?.callId ?? null,
          error: message,
          voiceAgentSessionId: credentials?.sessionId ?? null,
        },
      })
      setError(message)
      setCallingState(CallingState.IDLE)
    } finally {
      joiningRef.current = false
    }
  }, [credentials?.callId, credentials?.callType, credentials?.sessionId])

  const leave = useCallback(async () => {
    const call = callRef.current
    if (!call) return

    audioCleanupRef.current?.()
    audioCleanupRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-runtime",
      name: "call-leave-requested",
      payload: {
        callId: credentials?.callId ?? null,
        voiceAgentSessionId: credentials?.sessionId ?? null,
      },
    })

    try {
      await call.leave()
      recordSophiaCaptureEvent({
        category: "voice-runtime",
        name: "call-left",
        payload: {
          callId: credentials?.callId ?? null,
          voiceAgentSessionId: credentials?.sessionId ?? null,
        },
      })
    } catch {
      // Best-effort leave
    }
    setCallingState(CallingState.IDLE)
  }, [credentials?.callId, credentials?.sessionId])

  return {
    client,
    call,
    callingState,
    error,
    remoteParticipantSessionIds,
    join,
    leave,
  }
}
