"use client"

import type { ReactNode } from "react"
import {
  StreamVideo,
  StreamCall,
} from "@stream-io/video-react-sdk"
import { useStreamVoice, type StreamVoiceCredentials } from "../hooks/useStreamVoice"

type StreamVoiceProviderProps = {
  userId: string
  credentials: StreamVoiceCredentials | null
  children: ReactNode
}

/**
 * Wraps children in Stream Video + Call providers when a voice call is active.
 * When credentials are null, renders children without Stream context.
 */
export function StreamVoiceProvider({
  userId,
  credentials,
  children,
}: StreamVoiceProviderProps) {
  const { client, call } = useStreamVoice({ userId, credentials })

  if (!client || !call || !credentials) {
    return <>{children}</>
  }

  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>{children}</StreamCall>
    </StreamVideo>
  )
}
