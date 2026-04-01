"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { parseUsageLimitFromError } from "../lib/usage-limit-parser"
import { extractTextFromUiMessageStreamDump } from "../lib/ui-message-stream-parser"
import { useChatStore, type ChatMessage } from "../stores/chat-store"
import { useUsageLimitStore } from "../stores/usage-limit-store"
import { useConnectivityStore } from "../stores/connectivity-store"
import { usePlatformSignal } from "../hooks/usePlatformSignal"
import { copy } from "../copy"
import {
  normalizeStreamDataPart,
  parseArtifactsPayload,
  parseInterruptPayload,
  type StreamArtifactsPayload,
} from "../session/stream-contract-adapters"
import type { InterruptPayload } from "../types/session"

export type AiSdkChatMessageLike = {
  id: string
  role: string
  parts?: Array<{ type?: string; text?: string }>
}

export function mapAiSdkMessagesToChatMessages(
  messages: AiSdkChatMessageLike[],
  chatStatus: "submitted" | "streaming" | "ready" | "error",
  timestamps: Map<string, number>
): ChatMessage[] {
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id

  return messages.map((message) => {
    if (!timestamps.has(message.id)) {
      timestamps.set(message.id, Date.now())
    }

    const rawText = Array.isArray(message.parts)
      ? message.parts
          .filter((part) => part?.type === "text" && typeof part?.text === "string")
          .map((part) => part.text as string)
          .join("")
      : ""

    const content = extractTextFromUiMessageStreamDump(rawText)

    const isStreamingAssistant =
      message.role === "assistant" &&
      message.id === lastAssistantId &&
      (chatStatus === "submitted" || chatStatus === "streaming")

    const status = isStreamingAssistant
      ? "streaming"
      : (chatStatus === "error" && message.id === lastAssistantId && message.role === "assistant")
        ? "error"
        : "complete"

    return {
      id: message.id,
      role: message.role === "assistant" ? "sophia" : "user",
      content,
      createdAt: timestamps.get(message.id) || Date.now(),
      status,
      source: "text",
      turnId: message.role === "assistant" ? message.id : undefined,
    }
  })
}

export function buildAiSdkChatBody(params: {
  conversationId: string
  userId?: string
}): Record<string, unknown> {
  return {
    session_id: params.conversationId,
    session_type: "chat",
    context_mode: "life",
    ...(params.userId ? { user_id: params.userId } : {}),
  }
}

interface UseChatAiRuntimeParams {
  userId?: string
  onInterrupt?: (interrupt: InterruptPayload) => void
  onArtifacts?: (artifacts: StreamArtifactsPayload) => void
}

export function useChatAiRuntime({ userId, onInterrupt, onArtifacts }: UseChatAiRuntimeParams = {}) {
  const conversationId = useChatStore((state) => state.conversationId)
  const bindAiSdkRuntime = useChatStore((state) => state.bindAiSdkRuntime)
  const unbindAiSdkRuntime = useChatStore((state) => state.unbindAiSdkRuntime)
  const syncAiSdkState = useChatStore((state) => state.syncAiSdkState)

  const platform = usePlatformSignal()
  const timestampsRef = useRef<Map<string, number>>(new Map())
  const lastUserTextRef = useRef<string | null>(null)

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat", body: { platform } }), [platform])

  const {
    messages,
    status,
    error,
    sendMessage,
    stop,
  } = useChat({
    transport,
    onData: (dataPart) => {
      const normalizedPart = normalizeStreamDataPart(dataPart)
      if (!normalizedPart) return

      if (normalizedPart.type === "interrupt" || normalizedPart.type === "interruptV1") {
        const interrupt = parseInterruptPayload(normalizedPart.data)
        if (interrupt) {
          onInterrupt?.(interrupt)
        }
        return
      }

      if (
        normalizedPart.type === "artifacts" ||
        normalizedPart.type === "artifactsV1" ||
        normalizedPart.type === "companionArtifactsV1"
      ) {
        const artifacts = parseArtifactsPayload(normalizedPart.data)
        if (artifacts) {
          onArtifacts?.(artifacts)
        }
      }
    },
    onError: (runtimeError) => {
      const parsedLimit = parseUsageLimitFromError(runtimeError)
      if (parsedLimit) {
        useUsageLimitStore.getState().showModal(parsedLimit.info)
        return
      }

      const message = runtimeError.message || ""
      if (message.includes("offline") || message.includes("Backend unavailable") || message.includes("503")) {
        useConnectivityStore.getState().recordFailure()
      }
    },
  })

  useEffect(() => {
    if (status === "ready") {
      useConnectivityStore.getState().recordSuccess()
    }
  }, [status])

  const runtimeSend = useCallback(async ({ text }: { text: string }) => {
    const resolvedConversationId =
      useChatStore.getState().conversationId ||
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `chat_${Date.now()}`)

    if (!useChatStore.getState().conversationId) {
      useChatStore.setState({ conversationId: resolvedConversationId })
    }

    lastUserTextRef.current = text

    await sendMessage(
      { text },
      {
        body: buildAiSdkChatBody({
          conversationId: resolvedConversationId,
          userId,
        }),
      }
    )
  }, [sendMessage, userId])

  const runtimeRetry = useCallback(async () => {
    const message = lastUserTextRef.current
    if (!message) {
      return
    }
    await runtimeSend({ text: message })
  }, [runtimeSend])

  const runtimeStop = useCallback(() => {
    stop()
  }, [stop])

  useEffect(() => {
    bindAiSdkRuntime({
      send: runtimeSend,
      stop: runtimeStop,
      retry: runtimeRetry,
    })

    return () => {
      unbindAiSdkRuntime()
    }
  }, [bindAiSdkRuntime, runtimeRetry, runtimeSend, runtimeStop, unbindAiSdkRuntime])

  useEffect(() => {
    const mapped = mapAiSdkMessagesToChatMessages(
      messages as unknown as AiSdkChatMessageLike[],
      status,
      timestampsRef.current
    )

    syncAiSdkState({
      messages: mapped,
      chatStatus: status,
      error: error?.message || undefined,
      conversationId: conversationId || undefined,
    })
  }, [messages, status, error, syncAiSdkState, conversationId])

  useEffect(() => {
    if (status !== "error") {
      return
    }

    const message = error?.message || copy.chat.error
    useChatStore.setState({
      lastError: message,
      streamStatus: "error",
      isLocked: false,
    })
  }, [status, error])
}
