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

import { useCallback, useEffect, useRef, useState } from "react"
import { CallingState } from "@stream-io/video-react-sdk"
import {
  useStreamVoice,
  type StreamVoiceCredentials,
} from "./useStreamVoice"
import { useVoiceStore } from "../stores/voice-store"
import { usePresenceStore } from "../stores/presence-store"
import type { VoiceStage } from "./voice/voice-utils"

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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THINKING_TIMEOUT_MS = 15_000
const TOKEN_ENDPOINT = "/api/sophia"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callingStateToVoiceStage(cs: CallingState): VoiceStage {
  switch (cs) {
    case CallingState.JOINING:
    case CallingState.RECONNECTING:
      return "connecting"
    case CallingState.JOINED:
      return "listening"
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
): Promise<StreamVoiceCredentials> {
  const res = await fetch(`${TOKEN_ENDPOINT}/${userId}/voice/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform }),
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

  // --- Refs (mutable, non-render-triggering) -------------------------------
  const prevCallingStateRef = useRef<CallingState>(CallingState.IDLE)
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const destroyedRef = useRef(false)
  const onArtifactsRef = useRef(onArtifacts)
  const onUserTranscriptRef = useRef(onUserTranscript)
  const onAssistantResponseRef = useRef(onAssistantResponse)
  const sessionIdRef = useRef(sessionId)

  // Keep refs current without re-binding effects
  useEffect(() => { onArtifactsRef.current = onArtifacts }, [onArtifacts])
  useEffect(() => { onUserTranscriptRef.current = onUserTranscript }, [onUserTranscript])
  useEffect(() => { onAssistantResponseRef.current = onAssistantResponse }, [onAssistantResponse])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

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

  // --- Map CallingState → VoiceStage (only on actual changes) -------------
  useEffect(() => {
    // Only react to actual CallingState transitions — prevents stale
    // CallingState from overriding stages set explicitly by actions
    // (e.g. startTalking → "connecting" while CallingState is still IDLE)
    if (callingState === prevCallingStateRef.current) return
    prevCallingStateRef.current = callingState

    const mapped = callingStateToVoiceStage(callingState)
    setStage(mapped)

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
  }, [callingState, setListeningPresence, setSpeakingPresence, setMetaPresence, settlePresence])

  // --- Stream error forwarding ---------------------------------------------
  useEffect(() => {
    if (streamError) {
      setStage("error")
      setError(streamError)
      setVoiceFailed(streamError)
    }
  }, [streamError, setVoiceFailed])

  // --- Custom event listener (transcripts + artifacts) ---------------------
  useEffect(() => {
    if (!call || callingState !== CallingState.JOINED) return

    const handleCustomEvent = (event: { type: string; custom: Record<string, unknown> }) => {
      const { type } = event.custom ?? {}

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
  }, [call, callingState, addVoiceMessage, clearThinking, startThinkingTimeout, setListeningPresence, setSpeakingPresence, setMetaPresence])

  // --- Actions -------------------------------------------------------------

  const startTalking = useCallback(async () => {
    if (!userId) {
      setError("No user ID")
      setStage("error")
      return
    }

    setStage("connecting")
    setError(undefined)
    setPartialReply("")
    setFinalReply("")

    try {
      const creds = await fetchStreamCredentials(userId, "voice")
      setCredentials(creds)
      // join() will be triggered by useStreamVoice once credentials cause client init
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect"
      setError(message)
      setStage("error")
      setVoiceFailed(message)
    }
  }, [userId, setVoiceFailed])

  // Auto-join when credentials arrive and call is ready
  useEffect(() => {
    if (credentials && call && callingState === CallingState.IDLE) {
      join()
    }
  }, [credentials, call, callingState, join])

  const stopTalking = useCallback(async () => {
    clearThinking()
    try {
      await leave()
    } catch {
      // Best-effort
    }
    setCredentials(null)
    setStage("idle")
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [leave, clearThinking, setListeningPresence, setSpeakingPresence, settlePresence])

  const bargeIn = useCallback(() => {
    clearThinking()
    // Leave the call — Voice Agent detects disconnect as barge-in
    leave().catch(() => {})
    setCredentials(null)
    setStage("idle")
    setListeningPresence(false)
    setSpeakingPresence(false)
    settlePresence()
  }, [leave, clearThinking, setListeningPresence, setSpeakingPresence, settlePresence])

  const resetVoiceState = useCallback(() => {
    clearThinking()
    leave().catch(() => {})
    setCredentials(null)
    setStage("idle")
    setPartialReply("")
    setFinalReply("")
    setError(undefined)
    resetPresence()
  }, [leave, clearThinking, resetPresence])

  // --- Cleanup on unmount --------------------------------------------------
  useEffect(() => {
    return () => {
      destroyedRef.current = true
      if (thinkingTimeoutRef.current) {
        clearTimeout(thinkingTimeoutRef.current)
      }
    }
  }, [])

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
  }
}
