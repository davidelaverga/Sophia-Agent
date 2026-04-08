/**
 * Hook for managing WebSocket connection to voice backend
 * Handles connection lifecycle, message handling, and reconnection
 * 
 * Compatible with the Sophia voice backend, which expects:
 * - Query param: session_id
 * - Binary data: audio chunks
 * - Text commands: BARGE_IN, END_OF_SPEECH
 */

import { useRef, useCallback } from "react"

import { httpToWs } from "../../hooks/voice/voice-utils"
import { debugLog, debugWarn } from "../../lib/debug-logger"

import {
  parseIncomingVoiceWebSocketMessage,
  type VoiceWebSocketMessage,
} from "./voice-websocket-message-parser"

export type WebSocketMessage = VoiceWebSocketMessage

export type WebSocketHandlers = {
  onOpen?: () => void
  onClose?: (code: number, reason: string) => void
  onError?: (error: Event) => void
  onMessage?: (data: WebSocketMessage) => void
  onBinaryMessage?: (data: ArrayBuffer) => void
}

export function useVoiceWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const connectPromiseRef = useRef<Promise<WebSocket> | null>(null)

  /**
   * Connect to WebSocket server
   * Backend expects: /ws/voice?session_id=xxx&token=xxx
   */
  const connect = useCallback(async (
    baseUrl: string,
    sessionId: string,
    handlers: WebSocketHandlers = {},
    token?: string
  ): Promise<WebSocket> => {
    // Return existing connection if open
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return wsRef.current
    }

    // Return pending connection if connecting
    if (connectPromiseRef.current !== null) {
      return connectPromiseRef.current
    }

    // Create new connection
    connectPromiseRef.current = new Promise<WebSocket>((resolve, reject) => {
      try {
        const wsUrl = new URL(httpToWs(baseUrl) + "/ws/voice")
        wsUrl.searchParams.set("session_id", sessionId)
        if (token) {
          wsUrl.searchParams.set("token", token)
        }

        debugLog("WebSocket", "Connecting", { url: wsUrl.toString() })
        
        const ws = new WebSocket(wsUrl.toString())
        ws.binaryType = "arraybuffer"
        wsRef.current = ws

        const timeout = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            ws.close()
            reject(new Error("WebSocket connection timeout"))
          }
        }, 10000)

        ws.onopen = () => {
          clearTimeout(timeout)
          connectPromiseRef.current = null
          debugLog("WebSocket", "Connected successfully")
          handlers.onOpen?.()
          resolve(ws)
        }

        ws.onclose = (event) => {
          clearTimeout(timeout)
          connectPromiseRef.current = null
          wsRef.current = null
          debugLog("WebSocket", "Closed", { code: event.code, reason: event.reason })
          handlers.onClose?.(event.code, event.reason)
        }

        ws.onerror = (error) => {
          clearTimeout(timeout)
          connectPromiseRef.current = null
          debugWarn("WebSocket", "Connection error", { error })
          handlers.onError?.(error)
          reject(new Error("WebSocket connection failed"))
        }

        ws.onmessage = (event) => {
          // Handle binary audio data from V4 backend
          if (event.data instanceof ArrayBuffer) {
            debugLog("WebSocket", "Received binary audio", { bytes: event.data.byteLength })
            handlers.onBinaryMessage?.(event.data)
            return
          }
          
          // Handle text messages (JSON or control messages)
          if (typeof event.data === "string") {
            const parsedMessage = parseIncomingVoiceWebSocketMessage(event.data)

            if (
              parsedMessage.type === "rate_limited" ||
              parsedMessage.type === "barge_in_ack" ||
              parsedMessage.type === "unsupported_format"
            ) {
              debugLog("WebSocket", "Control message", { raw: event.data })
            } else if (parsedMessage.type === "error") {
              debugWarn("WebSocket", "Server error", { message: parsedMessage.message ?? event.data })
            } else if (parsedMessage.type === "text") {
              debugLog("WebSocket", "Text message", { text: parsedMessage.text })
            }

            handlers.onMessage?.(parsedMessage)
          }
        }
      } catch (err) {
        connectPromiseRef.current = null
        reject(err)
      }
    })

    return connectPromiseRef.current
  }, [])

  /**
   * Send binary data (audio) through WebSocket
   */
  const sendBinary = useCallback((data: ArrayBuffer | Blob) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
      return true
    }
    return false
  }, [])

  /**
   * Send text command through WebSocket
   * V4 backend accepts: BARGE_IN, END_OF_SPEECH
   */
  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(text)
      return true
    }
    return false
  }, [])

  /**
   * Close WebSocket connection
   */
  const disconnect = useCallback((code = 1000, reason = "Client disconnect") => {
    const current = wsRef.current
    if (current) {
      try {
        current.onopen = null
        current.onclose = null
        current.onerror = null
        current.onmessage = null

        if (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN) {
          current.close(code, reason)
        }
      } catch {
        // Ignore close errors
      }
    }
    wsRef.current = null
    connectPromiseRef.current = null
  }, [])

  /**
   * Check if WebSocket is connected
   */
  const isConnected = useCallback(() => {
    return wsRef.current?.readyState === WebSocket.OPEN
  }, [])

  return {
    ws: wsRef.current,
    connect,
    sendBinary,
    sendText,
    disconnect,
    isConnected,
  }
}