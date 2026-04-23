"use client"

/**
 * useStreamVoiceSession — Replaces useVoiceLoop for Stream WebRTC transport.
 *
 * Maps Stream SDK call state + browser-facing Sophia events to the VoiceStage interface
 * that all UI components depend on. Handles:
 * - Token fetching from backend (Unit 1 endpoint)
 * - Call lifecycle via useStreamVoice (Unit 2)
 * - VoiceStage transitions from CallingState + participant events
 * - Transcript and artifact forwarding via SSE, with Stream custom events as fallback
 */

import { CallingState } from "@stream-io/video-react-sdk"
import { useCallback, useEffect, useRef, useState } from "react"

import { logger } from "../lib/error-logger"
import { recordSophiaCaptureEvent } from "../lib/session-capture"
import type { ContextMode, PresetType } from "../lib/session-types"
import { reconcileVoiceTranscript } from "../lib/voice-transcript-reconciliation"
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
  threadId?: string
  onUserTranscript?: (text: string) => void
  onAssistantResponse?: (text: string) => void
  onArtifacts?: (artifacts: Record<string, unknown>) => void
  onBuilderTask?: (task: Record<string, unknown>) => void
}

type SophiaVoiceEventSource = "custom" | "sse"

export type StreamVoiceSessionReturn = {
  stage: VoiceStage
  partialReply: string
  finalReply: string
  error: string | undefined
  startTalking: () => Promise<void>
  stopTalking: () => Promise<void>
  /** Mute the microphone while keeping the call + agent alive. Cheap toggle (~0ms).
   *  Use instead of stopTalking when the user is still in-session and only wants to pause mic. */
  muteMic: () => Promise<void>
  /** Unmute the microphone. If no live call exists, falls back to startTalking (full connect). */
  unmuteMic: () => Promise<void>
  /** True when the mic is currently muted via muteMic. */
  isMuted: boolean
  /** True when the WebRTC call is JOINED (agent session alive on server). */
  hasLiveCall: boolean
  bargeIn: () => void
  /** Clears speaking UI state without tearing down transport (SSE/call/credentials stay alive). */
  softBargeIn: () => void
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
const AUTO_PRECONNECT_DELAY_MS = 250
const PREPARED_VOICE_CONNECT_TTL_MS = 30_000

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

function buildVoiceConnectKey(
  userId: string,
  platform: string,
  contextMode: ContextMode,
  ritual: string | null,
  sessionId?: string,
  threadId?: string,
): string {
  return JSON.stringify({
    userId,
    platform,
    contextMode,
    ritual,
    sessionId: sessionId ?? null,
    threadId: threadId ?? null,
  })
}

async function fetchStreamCredentials(
  userId: string,
  platform: string,
  contextMode: ContextMode,
  ritual: string | null,
  sessionId?: string,
  threadId?: string,
  signal?: AbortSignal,
): Promise<StreamVoiceCredentials> {
  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      platform,
      context_mode: contextMode,
      ritual,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
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
    threadId: typeof data.thread_id === "string" ? data.thread_id : null,
    streamUrl: typeof data.stream_url === "string" ? data.stream_url : null,
  }
}

async function prewarmStreamVoiceConnect(
  _userId: string,
  _signal?: AbortSignal,
): Promise<void> {
  // Frontend auth prewarm is intentionally a no-op. The real warmup happens once
  // we have prepared voice credentials and can call /voice/warmup with session data.
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
      ...(credentials.threadId ? { thread_id: credentials.threadId } : {}),
    }),
    keepalive: options.keepalive,
  })

  if (res.ok) {
    return
  }

  const body = await res.text().catch(() => "")
  throw new Error(`Voice disconnect failed (${res.status}): ${body}`)
}

async function requestVoiceWarmup(
  userId: string,
  credentials: StreamVoiceCredentials,
  signal?: AbortSignal,
): Promise<void> {
  if (!credentials.sessionId) {
    return
  }

  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/warmup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      call_id: credentials.callId,
      session_id: credentials.sessionId,
    }),
  })

  if (res.ok) {
    return
  }

  const body = await res.text().catch(() => "")
  throw new Error(`Voice warmup failed (${res.status}): ${body}`)
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
  const {
    sessionId,
    threadId,
    onUserTranscript,
    onAssistantResponse,
    onArtifacts,
    onBuilderTask,
  } = options

  // --- State ---------------------------------------------------------------
  const [stage, setStage] = useState<VoiceStage>("idle")
  const [partialReply, setPartialReply] = useState("")
  const [finalReply, setFinalReply] = useState("")
  const [error, setError] = useState<string | undefined>(undefined)
  const [credentials, setCredentials] = useState<StreamVoiceCredentials | null>(null)
  const [isSophiaReady, setIsSophiaReady] = useState(false)
  const [isMuted, setIsMuted] = useState(false)

  // --- Refs (mutable, non-render-triggering) -------------------------------
  const prevCallingStateRef = useRef<CallingState>(CallingState.IDLE)
  const prevSophiaReadyRef = useRef(false)
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startupReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recentUserTranscriptIdsRef = useRef<string[]>([])
  const currentTurnUserTranscriptRef = useRef<string | null>(null)
  const softBargeInActiveRef = useRef(false)
  const destroyedRef = useRef(false)
  const errorStageLockRef = useRef(false)
  const isSophiaReadyRef = useRef(false)
  const credentialsRef = useRef<StreamVoiceCredentials | null>(null)
  const disconnectRequestKeyRef = useRef<string | null>(null)
  const onArtifactsRef = useRef(onArtifacts)
  const onBuilderTaskRef = useRef(onBuilderTask)
  const onUserTranscriptRef = useRef(onUserTranscript)
  const onAssistantResponseRef = useRef(onAssistantResponse)
  const sessionIdRef = useRef(sessionId)
  const pendingStartControllerRef = useRef<AbortController | null>(null)
  const startRequestVersionRef = useRef(0)
  const startInFlightRef = useRef(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const preferSseEventsRef = useRef(false)
  const connectPrewarmPromiseRef = useRef<Promise<void> | null>(null)
  const connectPrewarmControllerRef = useRef<AbortController | null>(null)
  const connectPrewarmAttemptedUserIdRef = useRef<string | null>(null)
  const autoPreconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preparedVoiceConnectKeyRef = useRef<string | null>(null)
  const preparedVoiceConnectPromiseRef = useRef<Promise<StreamVoiceCredentials | null> | null>(null)
  const preparedVoiceConnectControllerRef = useRef<AbortController | null>(null)
  const preparedVoiceCredentialsRef = useRef<StreamVoiceCredentials | null>(null)
  const preparedVoiceCredentialsAtRef = useRef<number>(0)
  const backendWarmupKeyRef = useRef<string | null>(null)
  const backendWarmupControllerRef = useRef<AbortController | null>(null)
  const autoPreconnectEnabledRef = useRef(true)
  const reconnectStartedAtRef = useRef<number | null>(null)

  // Keep refs current without re-binding effects
  useEffect(() => { credentialsRef.current = credentials }, [credentials])
  useEffect(() => { onArtifactsRef.current = onArtifacts }, [onArtifacts])
  useEffect(() => { onBuilderTaskRef.current = onBuilderTask }, [onBuilderTask])
  useEffect(() => { onUserTranscriptRef.current = onUserTranscript }, [onUserTranscript])
  useEffect(() => { onAssistantResponseRef.current = onAssistantResponse }, [onAssistantResponse])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { isSophiaReadyRef.current = isSophiaReady }, [isSophiaReady])
  useEffect(() => {
    autoPreconnectEnabledRef.current = true
    reconnectStartedAtRef.current = null
  }, [sessionId, threadId, userId])
  useEffect(() => {
    if (credentials?.callId && credentials?.sessionId) {
      disconnectRequestKeyRef.current = null
    }
  }, [credentials?.callId, credentials?.sessionId])
  useEffect(() => {
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    backendWarmupKeyRef.current = null
    reconnectStartedAtRef.current = null
  }, [sessionId, threadId, userId])

  // --- Platform signal ------------------------------------------------------
  const platform = usePlatformSignal()
  const contextMode = useSessionStore((state) => state.session?.contextMode ?? "life")
  const presetType = useSessionStore((state) => state.session?.presetType ?? null)
  const voiceRitual = resolveVoiceRitual(presetType)

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

  const clearCurrentTurnUserTranscript = useCallback(() => {
    currentTurnUserTranscriptRef.current = null
  }, [])

  const cancelPendingStartRequest = useCallback(() => {
    startRequestVersionRef.current += 1
    startInFlightRef.current = false
    pendingStartControllerRef.current?.abort()
    pendingStartControllerRef.current = null
  }, [])

  const closeEventSource = useCallback(() => {
    preferSseEventsRef.current = false
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  const clearAutoPreconnectTimer = useCallback(() => {
    if (autoPreconnectTimerRef.current) {
      clearTimeout(autoPreconnectTimerRef.current)
      autoPreconnectTimerRef.current = null
    }
  }, [])

  const clearPreparedVoiceConnectRefs = useCallback(() => {
    preparedVoiceConnectControllerRef.current?.abort()
    preparedVoiceConnectControllerRef.current = null
    preparedVoiceConnectPromiseRef.current = null
    preparedVoiceConnectKeyRef.current = null
    preparedVoiceCredentialsRef.current = null
    preparedVoiceCredentialsAtRef.current = 0
  }, [])

  const scheduleBackendWarmup = useCallback((nextCredentials: StreamVoiceCredentials | null) => {
    if (!userId || !nextCredentials?.sessionId) {
      return
    }

    const warmupKey = `${userId}:${nextCredentials.callId}:${nextCredentials.sessionId}`
    if (backendWarmupKeyRef.current === warmupKey) {
      return
    }

    backendWarmupControllerRef.current?.abort()
    backendWarmupKeyRef.current = warmupKey

    const controller = new AbortController()
    backendWarmupControllerRef.current = controller
    const warmupStartedAt = Date.now()

    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "backend-warmup-started",
      payload: {
        callId: nextCredentials.callId,
        sessionId: sessionIdRef.current ?? null,
        voiceAgentSessionId: nextCredentials.sessionId,
      },
    })

    void requestVoiceWarmup(userId, nextCredentials, controller.signal)
      .then(() => {
        if (controller.signal.aborted) {
          return
        }

        if (backendWarmupControllerRef.current === controller) {
          backendWarmupControllerRef.current = null
        }

        const durationMs = Date.now() - warmupStartedAt

        logger.debug("StreamVoiceSession", "Voice backend warmup ready", {
          userId,
          callId: nextCredentials.callId,
          voiceAgentSessionId: nextCredentials.sessionId,
          durationMs,
        })

        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "backend-warmup-completed",
          payload: {
            callId: nextCredentials.callId,
            durationMs,
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: nextCredentials.sessionId,
          },
        })
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          return
        }

        if (backendWarmupControllerRef.current === controller) {
          backendWarmupControllerRef.current = null
        }
        if (backendWarmupKeyRef.current === warmupKey) {
          backendWarmupKeyRef.current = null
        }

        const durationMs = Date.now() - warmupStartedAt

        logger.debug("StreamVoiceSession", "Voice backend warmup failed", {
          userId,
          callId: nextCredentials.callId,
          durationMs,
          voiceAgentSessionId: nextCredentials.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "backend-warmup-failed",
          payload: {
            callId: nextCredentials.callId,
            durationMs,
            error: err instanceof Error ? err.message : String(err),
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: nextCredentials.sessionId,
          },
        })
      })
  }, [userId])

  const releasePreparedVoiceConnect = useCallback(async (options: { keepalive?: boolean } = {}) => {
    const preparedCredentials = preparedVoiceCredentialsRef.current
    const activeCredentials = credentialsRef.current

    clearPreparedVoiceConnectRefs()

    if (!userId || !preparedCredentials?.sessionId) {
      return
    }

    if (
      activeCredentials?.callId === preparedCredentials.callId
      && activeCredentials?.sessionId === preparedCredentials.sessionId
    ) {
      return
    }

    try {
      await requestVoiceDisconnect(userId, preparedCredentials, options)
    } catch {
      // Best-effort cleanup for unused preconnected sessions.
    }
  }, [clearPreparedVoiceConnectRefs, userId])

  const prewarmVoiceConnect = useCallback(() => {
    if (!userId) {
      return null
    }

    if (
      connectPrewarmAttemptedUserIdRef.current === userId
      || connectPrewarmPromiseRef.current !== null
    ) {
      return connectPrewarmPromiseRef.current
    }

    connectPrewarmAttemptedUserIdRef.current = userId
    const controller = new AbortController()
    connectPrewarmControllerRef.current = controller

    const promise = prewarmStreamVoiceConnect(userId, controller.signal)
      .catch((err) => {
        if (controller.signal.aborted) {
          return
        }

        logger.debug("StreamVoiceSession", "Voice connect prewarm failed", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        if (connectPrewarmControllerRef.current === controller) {
          connectPrewarmControllerRef.current = null
        }
        if (connectPrewarmPromiseRef.current === promise) {
          connectPrewarmPromiseRef.current = null
        }
      })

    connectPrewarmPromiseRef.current = promise
    return promise
  }, [userId])

  const preconnectVoiceSession = useCallback(() => {
    if (!userId || !autoPreconnectEnabledRef.current) {
      return null
    }

    const connectKey = buildVoiceConnectKey(
      userId,
      platform,
      contextMode,
      voiceRitual,
      sessionId,
      threadId,
    )

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedVoiceCredentialsRef.current
      && Date.now() - preparedVoiceCredentialsAtRef.current < PREPARED_VOICE_CONNECT_TTL_MS
    ) {
      return Promise.resolve(preparedVoiceCredentialsRef.current)
    }

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedVoiceConnectPromiseRef.current !== null
    ) {
      return preparedVoiceConnectPromiseRef.current
    }

    void releasePreparedVoiceConnect()

    const controller = new AbortController()
    preparedVoiceConnectControllerRef.current = controller
    preparedVoiceConnectKeyRef.current = connectKey
    const preconnectStartedAt = Date.now()

    logger.debug("StreamVoiceSession", "Preparing voice session", {
      userId,
      platform,
      contextMode,
      ritual: voiceRitual,
      threadId: threadId ?? null,
    })

    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "preconnect-started",
      payload: {
        userId,
        platform,
        sessionId: sessionIdRef.current ?? null,
        threadId: threadId ?? null,
      },
    })

    const promise = (async () => {
      if (connectPrewarmPromiseRef.current !== null) {
        await connectPrewarmPromiseRef.current
      }

      const creds = await fetchStreamCredentials(
        userId,
        platform,
        contextMode,
        voiceRitual,
        sessionId,
        threadId,
        controller.signal,
      )

      if (
        controller.signal.aborted
        || destroyedRef.current
        || preparedVoiceConnectControllerRef.current !== controller
        || preparedVoiceConnectKeyRef.current !== connectKey
      ) {
        if (creds.sessionId) {
          try {
            await requestVoiceDisconnect(userId, creds)
          } catch {
            // Best-effort cleanup for stale prefetched credentials.
          }
        }
        return null
      }

      preparedVoiceCredentialsRef.current = creds
      preparedVoiceCredentialsAtRef.current = Date.now()
      scheduleBackendWarmup(creds)
      const durationMs = Date.now() - preconnectStartedAt

      logger.debug("StreamVoiceSession", "Voice session preconnected", {
        userId,
        callId: creds.callId,
        durationMs,
        voiceAgentSessionId: creds.sessionId ?? null,
      })

      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "preconnect-ready",
        payload: {
          callId: creds.callId,
          durationMs,
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: creds.sessionId ?? null,
        },
      })
      return creds
    })()
      .catch((err) => {
        if (!controller.signal.aborted) {
          logger.debug("StreamVoiceSession", "Voice session preconnect failed", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
          recordSophiaCaptureEvent({
            category: "voice-session",
            name: "preconnect-failed",
            payload: {
              durationMs: Date.now() - preconnectStartedAt,
              error: err instanceof Error ? err.message : String(err),
              sessionId: sessionIdRef.current ?? null,
            },
          })
        }
        return null
      })
      .finally(() => {
        if (preparedVoiceConnectPromiseRef.current === promise) {
          preparedVoiceConnectPromiseRef.current = null
        }
        if (preparedVoiceConnectControllerRef.current === controller) {
          preparedVoiceConnectControllerRef.current = null
        }
      })

    preparedVoiceConnectPromiseRef.current = promise
    return promise
  }, [
    connectPrewarmPromiseRef,
    contextMode,
    platform,
    releasePreparedVoiceConnect,
    scheduleBackendWarmup,
    sessionId,
    threadId,
    userId,
    voiceRitual,
  ])

  const consumePreparedVoiceConnect = useCallback(async () => {
    if (!userId) {
      return null
    }

    const connectKey = buildVoiceConnectKey(
      userId,
      platform,
      contextMode,
      voiceRitual,
      sessionId,
      threadId,
    )

    const preparedCredentials = preparedVoiceCredentialsRef.current
    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedCredentials
      && Date.now() - preparedVoiceCredentialsAtRef.current < PREPARED_VOICE_CONNECT_TTL_MS
    ) {
      const preparedCredentialAgeMs = Date.now() - preparedVoiceCredentialsAtRef.current

      clearPreparedVoiceConnectRefs()
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "preconnect-reused",
        payload: {
          callId: preparedCredentials.callId,
          preparedCredentialAgeMs,
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: preparedCredentials.sessionId ?? null,
        },
      })
      return preparedCredentials
    }

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedVoiceConnectPromiseRef.current !== null
    ) {
      const prefetchedCredentials = await preparedVoiceConnectPromiseRef.current
      if (!prefetchedCredentials) {
        return null
      }

      if (
        preparedVoiceConnectKeyRef.current === connectKey
        && preparedVoiceCredentialsRef.current?.callId === prefetchedCredentials.callId
        && preparedVoiceCredentialsRef.current?.sessionId === prefetchedCredentials.sessionId
      ) {
        const preparedCredentialAgeMs = Date.now() - preparedVoiceCredentialsAtRef.current

        clearPreparedVoiceConnectRefs()
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "preconnect-reused",
          payload: {
            callId: prefetchedCredentials.callId,
            preparedCredentialAgeMs,
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: prefetchedCredentials.sessionId ?? null,
          },
        })
      }

      return prefetchedCredentials
    }

    if (
      preparedVoiceConnectKeyRef.current === connectKey
      && preparedCredentials
    ) {
      await releasePreparedVoiceConnect()
    }

    return null
  }, [
    clearPreparedVoiceConnectRefs,
    contextMode,
    platform,
    releasePreparedVoiceConnect,
    sessionId,
    threadId,
    userId,
    voiceRitual,
  ])

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

  const handleSophiaEvent = useCallback((
    type: string,
    data: Record<string, unknown> | undefined,
    source: SophiaVoiceEventSource,
  ) => {
    if (source === "custom" && preferSseEventsRef.current && type.startsWith("sophia.")) {
      return
    }

    if (type.startsWith("sophia.")) {
      recordSophiaCaptureEvent({
        category: source === "sse" ? "voice-sse" : "stream-custom",
        name: type,
        payload: {
          data,
          sessionId: sessionIdRef.current ?? null,
        },
      })
    }

    if (type === "sophia.transcript") {
      // When a voice command was intercepted via softBargeIn, suppress the
      // backend's response text/partial that was triggered by the command.
      if (softBargeInActiveRef.current) return

      const text = typeof data?.text === "string" ? data.text : ""
      if (!text) return

      const isFinal = data?.is_final === true || data?.final === true
      if (isFinal) {
        setFinalReply(text)
        setPartialReply("")
        addVoiceMessage(text)
        onAssistantResponseRef.current?.(text)
      } else {
        setPartialReply(text)
      }
    }

    if (type === "sophia.user_transcript") {
      const text = typeof data?.text === "string" ? data.text : ""
      if (!text) return

      const utteranceId = typeof data?.utterance_id === "string" ? data.utterance_id : null
      if (utteranceId) {
        if (hasSeenUserTranscriptId(utteranceId)) {
          recordSophiaCaptureEvent({
            category: "voice-session",
            name: "duplicate-user-transcript-ignored",
            payload: {
              utteranceId,
              sessionId: sessionIdRef.current ?? null,
            },
          })
          return
        }

        rememberUserTranscriptId(utteranceId)
      }

      const reconciledTranscript = reconcileVoiceTranscript(currentTurnUserTranscriptRef.current, text)
      if (!reconciledTranscript.changed && currentTurnUserTranscriptRef.current) {
        return
      }

      currentTurnUserTranscriptRef.current = reconciledTranscript.text
      onUserTranscriptRef.current?.(reconciledTranscript.text)
    }

    if (type === "sophia.artifact" && data) {
      onArtifactsRef.current?.(data)
    }

    if (type === "sophia.builder_task" && data) {
      onBuilderTaskRef.current?.(data)
    }

    if (type === "sophia.turn") {
      const phase = typeof data?.phase === "string"
        ? data.phase
        : data?.status === "started"
          ? "agent_started"
          : data?.status === "completed"
            ? "agent_ended"
            : null

      if (phase === "agent_started") {
        if (softBargeInActiveRef.current) {
          // Voice command intercepted this turn — don't transition to speaking.
          return
        }
        clearThinking()
        setStage("speaking")
        setListeningPresence(false)
        setSpeakingPresence(true)
        setMetaPresence("speaking")
      } else if (phase === "agent_ended") {
        softBargeInActiveRef.current = false
        clearCurrentTurnUserTranscript()
        setStage("listening")
        setSpeakingPresence(false)
        setListeningPresence(true)
        setMetaPresence("listening")
      } else if (phase === "user_ended") {
        softBargeInActiveRef.current = false
        setStage("thinking")
        setListeningPresence(false)
        setSpeakingPresence(false)
        setMetaPresence("thinking")
        startThinkingTimeout()
      }
    }
  }, [addVoiceMessage, clearCurrentTurnUserTranscript, clearThinking, hasSeenUserTranscriptId, rememberUserTranscriptId, startThinkingTimeout, setListeningPresence, setSpeakingPresence, setMetaPresence])

  // --- Map CallingState → VoiceStage (only on actual changes) -------------
  useEffect(() => {
    const previousCallingState = prevCallingStateRef.current
    const previousSophiaReady = prevSophiaReadyRef.current

    if (
      callingState === previousCallingState
      && isSophiaReady === previousSophiaReady
    ) return

    if (callingState === CallingState.RECONNECTING && previousCallingState !== CallingState.RECONNECTING) {
      reconnectStartedAtRef.current = Date.now()
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "reconnect-started",
        payload: {
          previousCallingState,
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: credentials?.sessionId ?? null,
          wasSophiaReady: previousSophiaReady,
        },
      })
    } else if (
      previousCallingState === CallingState.RECONNECTING
      && reconnectStartedAtRef.current !== null
    ) {
      const durationMs = Date.now() - reconnectStartedAtRef.current

      if (callingState === CallingState.JOINED) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "reconnect-recovered",
          payload: {
            durationMs,
            remoteParticipantCount: remoteParticipantSessionIds.length,
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: credentials?.sessionId ?? null,
          },
        })
        reconnectStartedAtRef.current = null
      } else if (callingState === CallingState.IDLE || callingState === CallingState.LEFT) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "reconnect-failed",
          payload: {
            durationMs,
            nextCallingState: callingState,
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: credentials?.sessionId ?? null,
          },
        })
        reconnectStartedAtRef.current = null
      }
    }

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
        previousCallingState,
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
    remoteParticipantSessionIds,
    setListeningPresence,
    setMetaPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  // --- Startup readiness detection ----------------------------------------
  useEffect(() => {
    if (callingState !== CallingState.JOINED) return

    const voiceAgentSessionId = credentials?.sessionId
    const hasRemoteParticipant = remoteParticipantSessionIds.length > 0
    if (!hasRemoteParticipant) return

    markSophiaReady("remote-participant", {
      matchedExpectedSession: voiceAgentSessionId
        ? remoteParticipantSessionIds.includes(voiceAgentSessionId)
        : false,
      remoteParticipantCount: remoteParticipantSessionIds.length,
    })
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
      if (reconnectStartedAtRef.current !== null) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "reconnect-failed",
          payload: {
            durationMs: Date.now() - reconnectStartedAtRef.current,
            error: streamError,
            nextCallingState: callingState,
            sessionId: sessionIdRef.current ?? null,
            voiceAgentSessionId: credentials?.sessionId ?? null,
          },
        })
        reconnectStartedAtRef.current = null
      }
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
  }, [callingState, clearStartupReadyTimeout, credentials?.sessionId, setVoiceFailed, streamError])

  // --- Stream custom event fallback ---------------------------------------
  useEffect(() => {
    if (!call || callingState !== CallingState.JOINED) return
    if (credentials?.streamUrl && typeof EventSource === "function") return

    const handleCustomEvent = (event: { type: string; custom: Record<string, unknown> }) => {
      const eventType = typeof event.custom?.type === "string" ? event.custom.type : null
      if (!eventType) return

      handleSophiaEvent(
        eventType,
        event.custom.data as Record<string, unknown> | undefined,
        "custom",
      )
    }

    const unsubscribe = call.on("custom", handleCustomEvent as Parameters<typeof call.on>[1])

    return () => {
      unsubscribe()
    }
  }, [call, callingState, credentials?.streamUrl, handleSophiaEvent])

  useEffect(() => {
    if (!credentials?.streamUrl || !credentials.sessionId) {
      closeEventSource()
      return
    }

    if (typeof EventSource !== "function") {
      return
    }

    const eventSource = new EventSource(credentials.streamUrl)
    eventSourceRef.current = eventSource

    const handleOpen = () => {
      if (eventSourceRef.current !== eventSource) return

      preferSseEventsRef.current = true
      recordSophiaCaptureEvent({
        category: "voice-sse",
        name: "stream-open",
        payload: {
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: credentials.sessionId,
          streamUrl: credentials.streamUrl,
        },
      })
    }
    const handleError = () => {
      if (eventSourceRef.current !== eventSource) return

      recordSophiaCaptureEvent({
        category: "voice-sse",
        name: "stream-error",
        payload: {
          readyState: eventSource.readyState,
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: credentials.sessionId,
        },
      })

      if (eventSource.readyState === EventSource.CLOSED) {
        preferSseEventsRef.current = false
        eventSource.close()
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null
        }
      }
    }

    const eventTypes = [
      "sophia.transcript",
      "sophia.user_transcript",
      "sophia.artifact",
      "sophia.builder_task",
      "sophia.turn",
      "sophia.turn_diagnostic",
    ] as const

    const eventListeners = eventTypes.map((eventType) => {
      const listener = (event: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(event.data) as {
            type?: string
            data?: Record<string, unknown>
          }
          if (typeof parsed.type !== "string") return

          handleSophiaEvent(parsed.type, parsed.data, "sse")
        } catch {
          recordSophiaCaptureEvent({
            category: "voice-sse",
            name: "invalid-event-payload",
            payload: {
              eventType,
              sessionId: sessionIdRef.current ?? null,
            },
          })
        }
      }

      eventSource.addEventListener(eventType, listener as EventListener)
      return { eventType, listener }
    })

    eventSource.addEventListener("open", handleOpen)
    eventSource.addEventListener("error", handleError)

    return () => {
      for (const { eventType, listener } of eventListeners) {
        eventSource.removeEventListener(eventType, listener as EventListener)
      }
      eventSource.removeEventListener("open", handleOpen)
      eventSource.removeEventListener("error", handleError)

      if (eventSourceRef.current === eventSource) {
        preferSseEventsRef.current = false
        eventSourceRef.current = null
      }

      eventSource.close()
    }
  }, [closeEventSource, credentials?.sessionId, credentials?.streamUrl, handleSophiaEvent])

  useEffect(() => {
    if (!userId) {
      autoPreconnectEnabledRef.current = true
      clearAutoPreconnectTimer()
      connectPrewarmAttemptedUserIdRef.current = null
      connectPrewarmPromiseRef.current = null
      connectPrewarmControllerRef.current?.abort()
      connectPrewarmControllerRef.current = null
      clearPreparedVoiceConnectRefs()
      return
    }

    void prewarmVoiceConnect()
  }, [clearAutoPreconnectTimer, clearPreparedVoiceConnectRefs, prewarmVoiceConnect, userId])

  const activeCallId = credentials?.callId ?? null
  const activeVoiceAgentSessionId = credentials?.sessionId ?? null

  useEffect(() => {
    if (!credentials || !call || callingState !== CallingState.IDLE) {
      return
    }

    logger.debug("StreamVoiceSession", "Auto-joining Stream voice call", {
      callId: credentials.callId,
      voiceAgentSessionId: credentials.sessionId ?? null,
    })
    void join()
  }, [call, callingState, credentials, join])

  useEffect(() => {
    if (!activeCallId || !activeVoiceAgentSessionId) {
      return
    }

    scheduleBackendWarmup(credentials)
  }, [activeCallId, activeVoiceAgentSessionId, credentials, scheduleBackendWarmup])

  useEffect(() => {
    if (
      !userId
      || !autoPreconnectEnabledRef.current
      || Boolean(credentials)
      || callingState !== CallingState.IDLE
      || startInFlightRef.current
    ) {
      return
    }

    clearAutoPreconnectTimer()
    autoPreconnectTimerRef.current = setTimeout(() => {
      autoPreconnectTimerRef.current = null

      if (
        !autoPreconnectEnabledRef.current
        || destroyedRef.current
        || credentialsRef.current
        || startInFlightRef.current
      ) {
        return
      }

      void preconnectVoiceSession()
    }, AUTO_PRECONNECT_DELAY_MS)

    return () => {
      clearAutoPreconnectTimer()
    }
  }, [callingState, clearAutoPreconnectTimer, credentials, preconnectVoiceSession, userId])

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

    if (startInFlightRef.current || callingState === CallingState.JOINING) {
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "start-talking-ignored",
        payload: {
          reason: "duplicate-connect",
          sessionId: sessionIdRef.current ?? null,
        },
      })
      return
    }

    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()

    const requestVersion = startRequestVersionRef.current + 1
    const controller = new AbortController()

    startRequestVersionRef.current = requestVersion
    pendingStartControllerRef.current = controller
    startInFlightRef.current = true

    errorStageLockRef.current = false
    closeEventSource()
    clearStartupReadyTimeout()
    isSophiaReadyRef.current = false
    reconnectStartedAtRef.current = null
    recentUserTranscriptIdsRef.current = []
    currentTurnUserTranscriptRef.current = null
    setIsSophiaReady(false)
    setStage("connecting")
    setError(undefined)
    setIsMuted(false)
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
      let credentialsSource: "prefetched" | "fresh" = "fresh"
      let creds = await consumePreparedVoiceConnect()

      if (connectPrewarmPromiseRef.current !== null) {
        await connectPrewarmPromiseRef.current
      }

      if (!creds) {
        logger.debug("StreamVoiceSession", "Fetching credentials", {
          userId,
          platform,
          contextMode,
          ritual: voiceRitual,
        })
        creds = await fetchStreamCredentials(
          userId,
          platform,
          contextMode,
          voiceRitual,
          sessionId,
          threadId,
          controller.signal,
        )
      } else {
        credentialsSource = "prefetched"
        logger.debug("StreamVoiceSession", "Using prefetched voice credentials", {
          userId,
          callId: creds.callId,
          voiceAgentSessionId: creds.sessionId,
        })
      }

      if (destroyedRef.current || startRequestVersionRef.current !== requestVersion) {
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "stale-connect-response",
          payload: {
            destroyed: destroyedRef.current,
            requestVersion,
            currentRequestVersion: startRequestVersionRef.current,
            callId: creds.callId,
            callType: creds.callType,
            voiceAgentSessionId: creds.sessionId ?? null,
            sessionId: sessionIdRef.current ?? null,
          },
        })
        if (creds.sessionId) {
          try {
            await requestVoiceDisconnect(userId, creds)
          } catch {
            // Best-effort cleanup for stale connect responses.
          }
        }
        return
      }

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
        source: credentialsSource,
        voiceAgentSessionId: creds.sessionId ?? null,
      })
      scheduleBackendWarmup(creds)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "credentials-received",
        payload: {
          callId: creds.callId,
          callType: creds.callType,
          source: credentialsSource,
          sessionId: sessionIdRef.current ?? null,
          voiceAgentSessionId: creds.sessionId ?? null,
        },
      })
      setCredentials(creds)
    } catch (err) {
      if (controller.signal.aborted) {
        return
      }

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
    } finally {
      if (startRequestVersionRef.current === requestVersion) {
        startInFlightRef.current = false
        pendingStartControllerRef.current = null
      }
    }
  }, [
    cancelPendingStartRequest,
    callingState,
    clearAutoPreconnectTimer,
    closeEventSource,
    clearStartupReadyTimeout,
    consumePreparedVoiceConnect,
    contextMode,
    failVoiceStartup,
    platform,
    scheduleBackendWarmup,
    sessionId,
    setVoiceFailed,
    threadId,
    userId,
    voiceRitual,
  ])

  const stopTalking = useCallback(async () => {
    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()
    closeEventSource()
    clearThinking()
    clearStartupReadyTimeout()
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    reconnectStartedAtRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "stop-talking-requested",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    await requestCurrentVoiceDisconnect()
    await releasePreparedVoiceConnect()
    try {
      await leave()
    } catch {
      // Best-effort
    }
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    currentTurnUserTranscriptRef.current = null
    setIsSophiaReady(false)
    setCredentials(null)
    setStage("idle")
    setIsMuted(false)
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [
    cancelPendingStartRequest,
    clearAutoPreconnectTimer,
    closeEventSource,
    clearStartupReadyTimeout,
    leave,
    clearThinking,
    requestCurrentVoiceDisconnect,
    releasePreparedVoiceConnect,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  /**
   * Soft barge-in: clears speaking/thinking UI state but keeps the transport
   * alive (SSE, call, credentials).  The Voice Agent handles native speech
   * interruption when it detects user audio, so we only need to update the
   * visual stage.  Use this for voice-command interceptions (download,
   * reflection, interrupt) that should NOT tear down the session.
   */
  const softBargeIn = useCallback(() => {
    softBargeInActiveRef.current = true
    clearThinking()
    currentTurnUserTranscriptRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "soft-barge-in",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    setStage("listening")
    setSpeakingPresence(false)
    setListeningPresence(true)
    setIsMuted(false)
    settlePresence()
  }, [
    clearThinking,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  const bargeIn = useCallback(() => {
    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()
    closeEventSource()
    clearThinking()
    clearStartupReadyTimeout()
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    reconnectStartedAtRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "barge-in",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    void releasePreparedVoiceConnect()
    void requestCurrentVoiceDisconnect()
    // Leave the call — Voice Agent detects disconnect as barge-in
    leave().catch(() => {})
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    currentTurnUserTranscriptRef.current = null
    setIsSophiaReady(false)
    setCredentials(null)
    setStage("idle")
    setIsMuted(false)
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [
    cancelPendingStartRequest,
    clearAutoPreconnectTimer,
    closeEventSource,
    clearStartupReadyTimeout,
    leave,
    clearThinking,
    requestCurrentVoiceDisconnect,
    releasePreparedVoiceConnect,
    setListeningPresence,
    setSpeakingPresence,
    settlePresence,
  ])

  const resetVoiceState = useCallback(() => {
    cancelPendingStartRequest()
    autoPreconnectEnabledRef.current = false
    clearAutoPreconnectTimer()
    closeEventSource()
    clearThinking()
    clearStartupReadyTimeout()
    backendWarmupControllerRef.current?.abort()
    backendWarmupControllerRef.current = null
    reconnectStartedAtRef.current = null
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "reset-voice-state",
      payload: {
        sessionId: sessionIdRef.current ?? null,
      },
    })
    void releasePreparedVoiceConnect()
    void requestCurrentVoiceDisconnect()
    leave().catch(() => {})
    errorStageLockRef.current = false
    isSophiaReadyRef.current = false
    recentUserTranscriptIdsRef.current = []
    currentTurnUserTranscriptRef.current = null
    setIsSophiaReady(false)
    setCredentials(null)
    setStage("idle")
    setPartialReply("")
    setFinalReply("")
    setError(undefined)
    setIsMuted(false)
    resetPresence()
  }, [cancelPendingStartRequest, clearAutoPreconnectTimer, closeEventSource, clearStartupReadyTimeout, leave, clearThinking, releasePreparedVoiceConnect, requestCurrentVoiceDisconnect, resetPresence])

  /**
   * Mute the microphone without tearing down the call/agent session.
   *
   * Keeps StreamVideoClient, Call, SSE, and the Voice Agent alive on the server.
   * Use this for the in-session mic toggle instead of stopTalking — avoids
   * the progressive latency accumulation caused by repeated create/destroy
   * cycles (Cartesia HTTP/2, Deepgram WebSocket, Stream SFU reconnects).
   */
  const muteMic = useCallback(async () => {
    if (!call) return
    try {
      await call.microphone.disable()
    } catch (err) {
      logger.logError(err, {
        component: "StreamVoiceSession",
        action: "muteMic",
      })
    }
    setIsMuted(true)
    setStage("idle")
    setListeningPresence(false)
    settlePresence()
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "mic-muted",
      payload: {
        sessionId: sessionIdRef.current ?? null,
        callId: credentials?.callId ?? null,
      },
    })
  }, [call, credentials?.callId, setListeningPresence, settlePresence])

  /**
   * Unmute the microphone. If no live call exists, fall back to startTalking
   * (full connect path).
   */
  const unmuteMic = useCallback(async () => {
    if (!call || callingState !== CallingState.JOINED) {
      await startTalking()
      return
    }
    try {
      await call.microphone.enable()
    } catch (err) {
      logger.logError(err, {
        component: "StreamVoiceSession",
        action: "unmuteMic",
      })
    }
    setIsMuted(false)
    setStage("listening")
    setListeningPresence(true)
    settlePresence()
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "mic-unmuted",
      payload: {
        sessionId: sessionIdRef.current ?? null,
        callId: credentials?.callId ?? null,
      },
    })
  }, [call, callingState, credentials?.callId, setListeningPresence, settlePresence, startTalking])

  // --- Cleanup on unmount --------------------------------------------------
  useEffect(() => {
    destroyedRef.current = false

    return () => {
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "hook-cleanup",
        payload: {
          sessionId: sessionIdRef.current ?? null,
          requestVersion: startRequestVersionRef.current,
        },
      })
      destroyedRef.current = true
      autoPreconnectEnabledRef.current = false
      reconnectStartedAtRef.current = null
      clearAutoPreconnectTimer()
      backendWarmupControllerRef.current?.abort()
      backendWarmupControllerRef.current = null
      connectPrewarmControllerRef.current?.abort()
      connectPrewarmControllerRef.current = null
      connectPrewarmPromiseRef.current = null
      cancelPendingStartRequest()
      closeEventSource()
      void releasePreparedVoiceConnect({ keepalive: true })
      void requestCurrentVoiceDisconnect({ keepalive: true })
      if (thinkingTimeoutRef.current) {
        clearTimeout(thinkingTimeoutRef.current)
      }
      clearStartupReadyTimeout()
    }
  }, [cancelPendingStartRequest, clearAutoPreconnectTimer, closeEventSource, clearStartupReadyTimeout, releasePreparedVoiceConnect, requestCurrentVoiceDisconnect])

  return {
    stage,
    partialReply,
    finalReply,
    error,
    startTalking,
    stopTalking,
    muteMic,
    unmuteMic,
    isMuted,
    hasLiveCall: callingState === CallingState.JOINED,
    bargeIn,
    softBargeIn,
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
