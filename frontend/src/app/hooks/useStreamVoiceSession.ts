"use client"

/**
 * useStreamVoiceSession — Replaces useVoiceLoop for Stream WebRTC transport.
 *
 * Maps Stream SDK call state + custom events to the VoiceStage interface
 * that all UI components depend on. Handles:
 * - Token fetching from backend (Unit 1 endpoint)
 * - Call lifecycle via useStreamVoice (Unit 2)
 * - VoiceStage transitions from CallingState + participant events
 * - Transcript and artifact forwarding via Stream custom events
 */

import { CallingState } from "@stream-io/video-react-sdk"
import { useCallback, useEffect, useRef, useState } from "react"

import { logger } from "../lib/error-logger"
import { recordSophiaCaptureEvent } from "../lib/session-capture"
import type { ContextMode, PresetType } from "../lib/session-types"
import type { VoiceStage } from "../lib/voice-types"
import { usePresenceStore } from "../stores/presence-store"
import { useSessionStore } from "../stores/session-store"
import { useVoiceStore } from "../stores/voice-store"

import { usePlatformSignal } from "./usePlatformSignal"
import {
  useStreamVoice,
  type StreamVoiceCredentials,
} from "./useStreamVoice"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UseStreamVoiceSessionOptions = {
  sessionId?: string
  onUserTranscript?: (text: string) => void
  onAssistantResponse?: (text: string) => void
  onArtifacts?: (artifacts: Record<string, unknown>) => void
}

export type StreamVoiceSessionReturn = {
  stage: VoiceStage
  partialReply: string
  finalReply: string
  error: string | undefined
  startTalking: () => Promise<void>
  stopTalking: () => Promise<void>
  bargeIn: () => void
  resetVoiceState: () => void
  /** Always false — Stream handles retries server-side */
  hasRetryableVoiceTurn: () => boolean
  /** Always resolves false — Stream handles retries server-side */
  retryLastVoiceTurn: () => Promise<boolean>
  /** Not applicable for Stream — always false */
  isReflectionTtsActive: boolean
  /** Not applicable for Stream — always false */
  needsUnlock: boolean
  /** Not applicable for Stream — no WebSocket path routing */
  path: undefined
  /** Not applicable for Stream — SDK manages MediaStream internally */
  stream: null
  /** No-op — Stream handles audio unlock natively */
  unlockAudio: () => void
  /** No-op — reflection TTS goes through Stream agent. Returns false (not spoken). */
  speakText: (text: string, traceId?: string) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THINKING_TIMEOUT_MS = 15_000
const STARTUP_READY_TIMEOUT_MS = 10_000
const STARTUP_READY_TIMEOUT_MESSAGE = "Sophia voice is unavailable right now. Try again."
const TOKEN_ENDPOINT = "/api/sophia"
const RECENT_UTTERANCE_IDS_LIMIT = 20

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callingStateToVoiceStage(
  cs: CallingState,
  isSophiaReady: boolean,
  hasActiveCredentials: boolean,
): VoiceStage {
  switch (cs) {
    case CallingState.JOINING:
    case CallingState.RECONNECTING:
      return "connecting"
    case CallingState.JOINED:
      if (!hasActiveCredentials) return "idle"
      return isSophiaReady ? "listening" : "connecting"
    case CallingState.LEFT:
    case CallingState.IDLE:
      return "idle"
    default:
      return "idle"
  }
}

async function fetchStreamCredentials(
  userId: string,
  platform: string,
  contextMode: ContextMode,
  ritual: string | null,
): Promise<StreamVoiceCredentials> {
  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform,
      context_mode: contextMode,
      ritual,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Voice connect failed (${res.status}): ${body}`)
  }
  const data = await res.json()
  return {
    apiKey: data.api_key,
    token: data.token,
    callType: data.call_type,
    callId: data.call_id,
    sessionId: typeof data.session_id === "string" ? data.session_id : null,
  }
}

async function requestVoiceDisconnect(
  userId: string,
  credentials: StreamVoiceCredentials,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  if (!credentials.sessionId) return

  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call_id: credentials.callId,
      session_id: credentials.sessionId,
    }),
    keepalive: options.keepalive,
  })

  if (res.ok) {
    return
  }

  const body = await res.text().catch(() => "")
  throw new Error(`Voice disconnect failed (${res.status}): ${body}`)
}

function resolveVoiceRitual(presetType: PresetType | null): string | null {
  switch (presetType) {
    case "prepare":
    case "debrief":
    case "reset":
    case "vent":
      return presetType
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStreamVoiceSession(
  userId?: string,
  options: UseStreamVoiceSessionOptions = {},
): StreamVoiceSessionReturn {
  const { sessionId, onUserTranscript, onAssistantResponse, onArtifacts } = options

  // --- State ---------------------------------------------------------------
  const [stage, setStage] = useState<VoiceStage>("idle")
  const [partialReply, setPartialReply] = useState("")
  const [finalReply, setFinalReply] = useState("")
  const [error, setError] = useState<string | undefined>(undefined)
  const [credentials, setCredentials] = useState<StreamVoiceCredentials | null>(null)
  const [isSophiaReady, setIsSophiaReady] = useState(false)

  // --- Refs (mutable, non-render-triggering) -------------------------------
  const prevCallingStateRef = useRef<CallingState>(CallingState.IDLE)
  const prevSophiaReadyRef = useRef(false)
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startupReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recentUserTranscriptIdsRef = useRef<string[]>([])
  const destroyedRef = useRef(false)
  const errorStageLockRef = useRef(false)
  const isSophiaReadyRef = useRef(false)
  const credentialsRef = useRef<StreamVoiceCredentials | null>(null)
  const disconnectRequestKeyRef = useRef<string | null>(null)
  const onArtifactsRef = useRef(onArtifacts)
  const onUserTranscriptRef = useRef(onUserTranscript)
  const onAssistantResponseRef = useRef(onAssistantResponse)
  const sessionIdRef = useRef(sessionId)

  // Keep refs current without re-binding effects
  useEffect(() => { credentialsRef.current = credentials }, [credentials])
  useEffect(() => { onArtifactsRef.current = onArtifacts }, [onArtifacts])
  useEffect(() => { onUserTranscriptRef.current = onUserTranscript }, [onUserTranscript])
  useEffect(() => { onAssistantResponseRef.current = onAssistantResponse }, [onAssistantResponse])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { isSophiaReadyRef.current = isSophiaReady }, [isSophiaReady])
  useEffect(() => {
    if (credentials?.callId && credentials?.sessionId) {
      disconnectRequestKeyRef.current = null
    }
  }, [credentials?.callId, credentials?.sessionId])

  // --- Platform signal ------------------------------------------------------
  const platform = usePlatformSignal()
  const contextMode = useSessionStore((state) => state.session?.contextMode ?? "life")
  const presetType = useSessionStore((state) => state.session?.presetType ?? null)

  // --- Stores --------------------------------------------------------------
  const addVoiceMessage = useVoiceStore((s) => s.addMessage)
  const setVoiceFailed = useVoiceStore((s) => s.setVoiceFailed)
  const setListeningPresence = usePresenceStore((s) => s.setListening)
  const setSpeakingPresence = usePresenceStore((s) => s.setSpeaking)
  const setMetaPresence = usePresenceStore((s) => s.setMetaStage)
  const settlePresence = usePresenceStore((s) => s.settleToRestingSoon)
  const resetPresence = usePresenceStore((s) => s.reset)

  // --- Stream Voice (Unit 2) -----------------------------------------------
  const {
    call,
    callingState,
    error: streamError,
    remoteParticipantSessionIds,
    join,
    leave,
  } = useStreamVoice({
    userId: userId ?? "anonymous",
    credentials,
  })

  // --- Thinking timeout helper ---------------------------------------------
  const clearThinking = useCallback(() => {
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current)
      thinkingTimeoutRef.current = null
    }
  }, [])

  const startThinkingTimeout = useCallback(() => {
    clearThinking()
    thinkingTimeoutRef.current = setTimeout(() => {
      if (!destroyedRef.current) {
        setStage("error")
        setError("Agent response timed out")
      }
    }, THINKING_TIMEOUT_MS)
  }, [clearThinking])

  const clearStartupReadyTimeout = useCallback(() => {
    if (startupReadyTimeoutRef.current) {
      clearTimeout(startupReadyTimeoutRef.current)
      startupReadyTimeoutRef.current = null
    }
  }, [])

  const hasSeenUserTranscriptId = useCallback((utteranceId: string) => {
    return recentUserTranscriptIdsRef.current.includes(utteranceId)
  }, [])

  const rememberUserTranscriptId = useCallback((utteranceId: string) => {
    recentUserTranscriptIdsRef.current = [
      ...recentUserTranscriptIdsRef.current.filter((existingId) => existingId !== utteranceId),
      utteranceId,
    ].slice(-RECENT_UTTERANCE_IDS_LIMIT)
  }, [])

  const markSophiaReady = useCallback(
    (
      reason: "remote-participant" | "custom-event",
      metadata?: Record<string, unknown>,
    ) => {
      if (isSophiaReadyRef.current) return

      clearStartupReadyTimeout()
      isSophiaReadyRef.current = true
      setIsSophiaReady(true)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "sophia-ready",
        payload: {
          reason,
          voiceAgentSessionId: credentials?.sessionId ?? null,
          sessionId: sessionIdRef.current ?? null,
          ...metadata,
        },
      })
    },
    [clearStartupReadyTimeout, credentials?.sessionId],
  )

  const failVoiceStartup = useCallback(
    (name: string, payload: Record<string, unknown> = {}) => {
      errorStageLockRef.current = true
      clearThinking()
      clearStartupReadyTimeout()
      isSophiaReadyRef.current = false
      setIsSophiaReady(false)
      setError(STARTUP_READY_TIMEOUT_MESSAGE)
      setStage("error")
      setVoiceFailed(STARTUP_READY_TIMEOUT_MESSAGE)
      setListeningPresence(false)
      setSpeakingPresence(false)
      settlePresence()
      recordSophiaCaptureEvent({
        category: "voice-session",
        name,
        payload: {
          voiceAgentSessionId: credentials?.sessionId ?? null,
          sessionId: sessionIdRef.current ?? null,
          ...payload,
        },
      })
      setCredentials(null)
    },
    [
      clearStartupReadyTimeout,
      clearThinking,
      credentials?.sessionId,
      setListeningPresence,
      setSpeakingPresence,
      settlePresence,
      setVoiceFailed,
    ],
  )

  const requestCurrentVoiceDisconnect = useCallback(
    async (options: { keepalive?: boolean } = {}) => {
      const activeCredentials = credentialsRef.current
      if (!userId || !activeCredentials?.sessionId) {
        return
      }

      const requestKey = `${activeCredentials.callId}:${activeCredentials.sessionId}`
      if (disconnectRequestKeyRef.current === requestKey) {
        return
      }

      disconnectRequestKeyRef.current = requestKey

      try {
        await requestVoiceDisconnect(userId, activeCredentials, options)
      } catch (err) {
        disconnectRequestKeyRef.current = null
        logger.warn("Voice disconnect failed", {
          component: "StreamVoiceSession",
          action: "requestVoiceDisconnect",
          metadata: {
            callId: activeCredentials.callId,
            voiceAgentSessionId: activeCredentials.sessionId,
            keepalive: options.keepalive ?? false,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    },
    [userId],
  )

  // --- Map CallingState → VoiceStage (only on actual changes) -------------
  useEffect(() => {
    if (
      callingState === prevCallingStateRef.current
      && isSophiaReady === prevSophiaReadyRef.current
    ) return

    prevCallingStateRef.current = callingState
    prevSophiaReadyRef.current = isSophiaReady

    const mapped = callingStateToVoiceStage(
      callingState,
      isSophiaReady,
      Boolean(credentials),
    )
    setStage((currentStage) => {
      if (errorStageLockRef.current && currentStage === "error") {
        return currentStage
      }

      if (
        callingState === CallingState.JOINED
        && isSophiaReady
        && (currentStage === "speaking" || currentStage === "thinking")
      ) {
        return currentStage
      }

      return mapped
    })
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "calling-state-changed",
      payload: {
        callingState,
        mappedStage: mapped,
        isSophiaReady,
        sessionId: sessionIdRef.current ?? null,
      },
    })

    if (errorStageLockRef.current) return

    // Update presence to match
    if (mapped === "listening") {
      setListeningPresence(true)
      setSpeakingPresence(false)
      setMetaPresence("listening")
    } else if (mapped === "connecting") {
      setListeningPresence(false)
      setSpeakingPresence(false)
      setMetaPresence("connecting")
    } else if (mapped === "idle") {
      setListeningPresence(false)
      setSpeakingPresence(false)
      settlePresence()
    }
  }, [
    callingState,
    credentials,
    isSophiaReady,
    setListeningPresence,
    setMetaPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  // --- Startup readiness detection ----------------------------------------
  useEffect(() => {
    if (callingState !== CallingState.JOINED) return

    const voiceAgentSessionId = credentials?.sessionId
    if (!voiceAgentSessionId) return
    if (!remoteParticipantSessionIds.includes(voiceAgentSessionId)) return

    markSophiaReady("remote-participant")
  }, [
    callingState,
    credentials?.sessionId,
    markSophiaReady,
    remoteParticipantSessionIds,
  ])

  useEffect(() => {
    if (!credentials?.sessionId || isSophiaReady) {
      clearStartupReadyTimeout()
      return
    }

    if (callingState === CallingState.IDLE || callingState === CallingState.LEFT) {
      clearStartupReadyTimeout()
      return
    }

    if (startupReadyTimeoutRef.current) return

    startupReadyTimeoutRef.current = setTimeout(() => {
      if (destroyedRef.current || isSophiaReadyRef.current) return

      logger.warn("Voice startup timed out waiting for Sophia readiness", {
        component: "StreamVoiceSession",
        action: "startTalking",
        metadata: {
          callId: credentials.callId,
          voiceAgentSessionId: credentials.sessionId,
        },
      })
      failVoiceStartup("startup-ready-timeout", {
        callId: credentials.callId,
        callType: credentials.callType,
      })
    }, STARTUP_READY_TIMEOUT_MS)

    return clearStartupReadyTimeout
  }, [
    callingState,
    clearStartupReadyTimeout,
    credentials?.callId,
    credentials?.callType,
    credentials?.sessionId,
    failVoiceStartup,
    isSophiaReady,
  ])

  // --- Stream error forwarding ---------------------------------------------
  useEffect(() => {
    if (streamError) {
      clearStartupReadyTimeout()
      setStage("error")
      setError(streamError)
      setVoiceFailed(streamError)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "stream-error",
        payload: {
          error: streamError,
          sessionId: sessionIdRef.current ?? null,
        },
      })
    }
  }, [clearStartupReadyTimeout, setVoiceFailed, streamError])

  // --- Custom event listener (transcripts + artifacts) ---------------------
  useEffect(() => {
    if (!call || callingState !== CallingState.JOINED) return

    const handleCustomEvent = (event: { type: string; custom: Record<string, unknown> }) => {
      const { type } = event.custom ?? {}

      if (typeof type === "string" && type.startsWith("sophia.")) {
        recordSophiaCaptureEvent({
          category: "stream-custom",
          name: type,
          payload: {
            data: event.custom.data,
            sessionId: sessionIdRef.current ?? null,
          },
        })
      }

      if (type === "sophia.transcript") {
        const data = event.custom.data as { text?: string; is_final?: boolean } | undefined
        if (!data?.text) return

        if (data.is_final) {
          setFinalReply(data.text)
          setPartialReply("")
          addVoiceMessage(data.text)
          onAssistantResponseRef.current?.(data.text)
        } else {
          setPartialReply(data.text)
        }
      }

      if (type === "sophia.user_transcript") {
        const data = event.custom.data as { text?: string; utterance_id?: string } | undefined
        if (!data?.text) return

        if (typeof data.utterance_id === "string") {
          if (hasSeenUserTranscriptId(data.utterance_id)) {
            recordSophiaCaptureEvent({
              category: "voice-session",
              name: "duplicate-user-transcript-ignored",
              payload: {
                utteranceId: data.utterance_id,
                sessionId: sessionIdRef.current ?? null,
              },
            })
            return
          }

          rememberUserTranscriptId(data.utterance_id)
        }

        onUserTranscriptRef.current?.(data.text)
      }

      if (type === "sophia.artifact") {
        const data = event.custom.data as Record<string, unknown> | undefined
        if (data) {
          onArtifactsRef.current?.(data)
        }
      }

      if (type === "sophia.turn") {
        const data = event.custom.data as { phase?: string } | undefined
        if (data?.phase === "agent_started") {
          clearThinking()
          setStage("speaking")
          setListeningPresence(false)
          setSpeakingPresence(true)
          setMetaPresence("speaking")
        } else if (data?.phase === "agent_ended") {
          setStage("listening")
          setSpeakingPresence(false)
          setListeningPresence(true)
          setMetaPresence("listening")
        } else if (data?.phase === "user_ended") {
          setStage("thinking")
          setListeningPresence(false)
          setSpeakingPresence(false)
          setMetaPresence("thinking")
          startThinkingTimeout()
        }
      }
    }

    const unsubscribe = call.on("custom", handleCustomEvent as Parameters<typeof call.on>[1])

    return () => {
      unsubscribe()
    }
  }, [call, callingState, addVoiceMessage, clearThinking, hasSeenUserTranscriptId, rememberUserTranscriptId, startThinkingTimeout, setListeningPresence, setSpeakingPresence, setMetaPresence])

  // --- Actions -------------------------------------------------------------

  const startTalking = useCallback(async () => {
    if (!userId) {
      setError("No user ID")
      setStage("error")
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "start-talking-rejected",
        payload: {
          reason: "missing-user-id",
          sessionId: sessionIdRef.current ?? null,
        },
      })
      return
    }

    errorStageLockRef.current = false
    clearStartupReadyTimeout()
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    setIsSophiaReady(false)
    setStage("connecting")
    setError(undefined)
    setPartialReply("")
    setFinalReply("")
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "start-talking-requested",
      payload: {
        userId,
        platform,
        sessionId: sessionIdRef.current ?? null,
      },
    })

    try {
      logger.debug("StreamVoiceSession", "Fetching credentials", {
        userId,
        platform,
        contextMode,
        ritual: resolveVoiceRitual(presetType),
      })
      const creds = await fetchStreamCredentials(
        userId,
        platform,
        contextMode,
        resolveVoiceRitual(presetType),
      )
      if (!creds.sessionId) {
        logger.warn("Voice connect returned without session_id", {
          component: "StreamVoiceSession",
          action: "startTalking",
          metadata: { callId: creds.callId },
        })
        failVoiceStartup("missing-session-id", {
          callId: creds.callId,
          callType: creds.callType,
        })
        return
      }
      logger.debug("StreamVoiceSession", "Credentials received", {
        callId: creds.callId,
      })
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "credentials-received",
        payload: {
          callId: creds.callId,
          callType: creds.callType,
          sessionId: sessionIdRef.current ?? null,
        },
      })
      setCredentials(creds)
      // join() will be triggered by useStreamVoice once credentials cause client init
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect"
      setError(message)
      setStage("error")
      setVoiceFailed(message)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "start-talking-failed",
        payload: {
          error: message,
          sessionId: sessionIdRef.current ?? null,
        },
      })
    }
  }, [
    clearStartupReadyTimeout,
    contextMode,
    failVoiceStartup,
    platform,
    presetType,
    setVoiceFailed,
    userId,
  ])

  // Auto-join when credentials arrive and call is ready
  useEffect(() => {
    if (credentials && call && callingState === CallingState.IDLE) {
      logger.debug("StreamVoiceSession", "Auto-join triggered")
      void join()
    }
  }, [credentials, call, callingState, join])

  const stopTalking = useCallback(async () => {
    clearThinking()
    clearStartupReadyTimeout()
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "stop-talking-requested",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    await requestCurrentVoiceDisconnect()
    try {
      await leave()
    } catch {
      // Best-effort
    }
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    setIsSophiaReady(false)
    setCredentials(null)
    setStage("idle")
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [
    clearStartupReadyTimeout,
    leave,
    clearThinking,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  const bargeIn = useCallback(() => {
    clearThinking()
    clearStartupReadyTimeout()
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "barge-in",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    void requestCurrentVoiceDisconnect()
    // Leave the call — Voice Agent detects disconnect as barge-in
    leave().catch(() => {})
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    setIsSophiaReady(false)
    setCredentials(null)
    setStage("idle")
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [
    clearStartupReadyTimeout,
    leave,
    clearThinking,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  const resetVoiceState = useCallback(() => {
    clearThinking()
    clearStartupReadyTimeout()
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "reset-voice-state",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    void requestCurrentVoiceDisconnect()
    leave().catch(() => {})
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    setIsSophiaReady(false)
    setCredentials(null)
    setStage("idle")
    setPartialReply("")
    setFinalReply("")
    setError(undefined)
    resetPresence()
  }, [clearStartupReadyTimeout, leave, clearThinking, resetPresence])

  // --- Cleanup on unmount --------------------------------------------------
  useEffect(() => {
    return () => {
      destroyedRef.current = true
      void requestCurrentVoiceDisconnect({ keepalive: true })
      if (thinkingTimeoutRef.current) {
        clearTimeout(thinkingTimeoutRef.current)
      }
      clearStartupReadyTimeout()
    }
  }, [clearStartupReadyTimeout, requestCurrentVoiceDisconnect])

  return {
    stage,
    partialReply,
    finalReply,
    error,
    startTalking,
    stopTalking,
    bargeIn,
    resetVoiceState,
    hasRetryableVoiceTurn: () => false,
    retryLastVoiceTurn: async () => false,
    isReflectionTtsActive: false,
    needsUnlock: false,
    path: undefined,
    stream: null,
    unlockAudio: () => {},
    speakText: async () => false,
  }
}
