"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  StreamVideoClient,
  type Call,
  type User,
  CallingState,
} from "@stream-io/video-react-sdk"

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
  const [client, setClient] = useState<StreamVideoClient | null>(null)
  const [call, setCall] = useState<Call | null>(null)
  const clientRef = useRef<StreamVideoClient | null>(null)
  const callRef = useRef<Call | null>(null)
  const joiningRef = useRef(false)
  const audioCleanupRef = useRef<(() => void) | null>(null)

  // Initialize client when credentials arrive
  useEffect(() => {
    if (!credentials) return

    console.log('[StreamVoice] Creating client for user:', userId, 'callId:', credentials.callId)
    const user: User = { id: userId, type: "authenticated" }
    const streamClient = new StreamVideoClient({
      apiKey: credentials.apiKey,
      user,
      token: credentials.token,
    })
    clientRef.current = streamClient
    setClient(streamClient)

    const streamCall = streamClient.call(credentials.callType, credentials.callId)
    callRef.current = streamCall
    setCall(streamCall)

    // Subscribe to calling state changes
    const unsubscribe = streamCall.state.callingState$.subscribe((state) => {
      setCallingState(state)
    })

    return () => {
      unsubscribe.unsubscribe()
      audioCleanupRef.current?.()
      audioCleanupRef.current = null
      streamCall.leave().catch(() => {})
      streamClient.disconnectUser().catch(() => {})
      clientRef.current = null
      callRef.current = null
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
      console.log('[StreamVoice] join() starting — disabling camera, enabling mic')
      // Audio-only: disable camera BEFORE join to prevent getUserMedia({video})
      await call.camera.disable()
      await call.microphone.enable()

      console.log('[StreamVoice] joining call with create:true')
      await call.join({ create: true })
      console.log('[StreamVoice] call.join() succeeded — callingState:', call.state.callingState)

      // Bind remote audio since we're outside <StreamCall> context
      audioCleanupRef.current = bindRemoteAudio(call)
      console.log('[StreamVoice] remote audio bound')
    } catch (err) {
      console.error('[StreamVoice] join() FAILED:', err)
      const message = err instanceof Error ? err.message : "Failed to join call"
      setError(message)
      setCallingState(CallingState.IDLE)
    } finally {
      joiningRef.current = false
    }
  }, [])

  const leave = useCallback(async () => {
    const call = callRef.current
    if (!call) return

    audioCleanupRef.current?.()
    audioCleanupRef.current = null

    try {
      await call.leave()
    } catch {
      // Best-effort leave
    }
    setCallingState(CallingState.IDLE)
  }, [])

  return {
    client,
    call,
    callingState,
    error,
    join,
    leave,
  }
}
