"use client"

import {
  StreamVideoClient,
  type Call,
  type User,
  CallingState,
} from "@stream-io/video-react-sdk"
import { useCallback, useEffect, useRef, useState } from "react"

import { logger } from "../lib/error-logger"
import { recordSophiaCaptureEvent } from "../lib/session-capture"

/**
 * Binds audio elements for remote participants using the SDK's own
 * call.bindAudioElement() API so the AudioBindingsWatchdog is satisfied.
 * Returns a cleanup function.
 */
function bindRemoteAudio(call: Call): () => void {
  const boundElements = new Map<string, { el: HTMLAudioElement; cleanup: (() => void) | undefined }>()

  const sub = call.state.remoteParticipants$.subscribe((participants) => {
    const currentSessionIds = new Set(participants.map((p) => p.sessionId))

    // Remove elements for participants who left
    for (const [sessionId, entry] of boundElements) {
      if (!currentSessionIds.has(sessionId)) {
        entry.cleanup?.()
        entry.el.remove()
        boundElements.delete(sessionId)
      }
    }

    // Add elements for new participants
    for (const p of participants) {
      if (!boundElements.has(p.sessionId)) {
        const audioEl = document.createElement("audio")
        audioEl.autoplay = true
        audioEl.style.display = "none"
        document.body.appendChild(audioEl)
        const cleanup = call.bindAudioElement(audioEl, p.sessionId, "audioTrack")
        boundElements.set(p.sessionId, { el: audioEl, cleanup })
      }
    }
  })

  return () => {
    sub.unsubscribe()
    for (const [, entry] of boundElements) {
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

    // Subscribe to calling state changes
    const unsubscribe = streamCall.state.callingState$.subscribe((state) => {
      setCallingState(state)
    })

    const remoteParticipantsSubscription = streamCall.state.remoteParticipants$.subscribe((participants) => {
      setRemoteParticipantSessionIds(participants.map((participant) => participant.sessionId))
    })

    return () => {
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
      audioCleanupRef.current = bindRemoteAudio(call)
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
