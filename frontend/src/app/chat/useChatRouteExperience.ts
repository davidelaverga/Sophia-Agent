"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useCompanionRuntime } from "../companion-runtime/useCompanionRuntime"
import { copy } from "../copy"
import { useInterrupt } from "../hooks/useInterrupt"
import { usePlatformSignal } from "../hooks/usePlatformSignal"
import { useSessionPersistence } from "../hooks/useSessionPersistence"
import type { StreamVoiceSessionReturn } from "../hooks/useStreamVoiceSession"
import { useUsageMonitor } from "../hooks/useUsageMonitor"
import {
  cancelBuilderTask as requestBuilderTaskCancellation,
  getBuilderArtifactFromStatus,
  getBuilderTaskPhaseFromStatus,
  getBuilderTaskStatus,
  mergeBuilderTaskStatus,
} from "../lib/builder-workflow"
import { logger } from "../lib/error-logger"
import { recordSophiaCaptureEvent } from "../lib/session-capture"
import {
  emitRecoveryTelemetry,
  recoverFromDisconnect,
  shouldAttemptRecovery,
} from "../lib/stream-recovery"
import { useAuth } from "../providers"
import {
  useChatStore,
  type ChatMessage,
} from "../stores/chat-store"
import { emitChatStreamRecovered } from "../stores/chat-store-events"
import {
  applyRecoveredResponse,
  isRecoverableStreamStatus,
  selectLastUserMessage,
} from "../stores/chat-store-recovery-policies"
import { useConnectivityStore } from "../stores/connectivity-store"
import { useEmotionStore } from "../stores/emotion-store"
import { useMessageMetadataStore } from "../stores/message-metadata-store"
import { usePresenceStore } from "../stores/presence-store"
import { useRecapStore } from "../stores/recap-store"
import { useUiStore } from "../stores/ui-store"
import { useUsageLimitStore } from "../stores/usage-limit-store"
import type { BuilderArtifactV1 } from "../types/builder-artifact"
import type { BuilderTaskV1 } from "../types/builder-task"
import type { RecapArtifactsV1 } from "../types/recap"
import type { InterruptPayload, RitualArtifacts } from "../types/session"

import {
  applyChatRouteArtifacts,
  mapRecapArtifactsToRitualArtifacts,
} from "./chat-voice-artifacts"

export type RouteChatMessageLike = {
  id: string
  role: string
  parts?: Array<{ type?: string; text?: string }>
}

export function mapRouteMessagesToChatMessages(
  messages: RouteChatMessageLike[],
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

    const content = Array.isArray(message.parts)
      ? message.parts
          .filter((part) => part?.type === "text" && typeof part?.text === "string")
          .map((part) => part.text)
          .join("")
      : ""

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

export function buildChatRouteBody(params: {
  conversationId: string
  userId?: string
  threadId?: string
}): Record<string, unknown> {
  return {
    session_id: params.conversationId,
    session_type: "chat",
    context_mode: "life",
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.userId ? { user_id: params.userId } : {}),
  }
}

export type ChatRouteExperience = {
  conversationId?: string
  threadId?: string
  recapArtifacts?: RecapArtifactsV1
  setRecapArtifacts: (sessionId: string, artifacts: RecapArtifactsV1) => void
  chatArtifacts: RitualArtifacts | null
  builderArtifact: BuilderArtifactV1 | null
  builderTask: BuilderTaskV1 | null
  clearBuilderTask: () => void
  cancelBuilderTask: () => Promise<void>
  isCancellingBuilderTask: boolean
  voiceState: StreamVoiceSessionReturn
  pendingInterrupt: InterruptPayload | null
  interruptQueue: InterruptPayload[]
  isResuming: boolean
  resumeError: string | null
  canRetryResume: boolean
  handleInterruptSelect: (optionId: string) => Promise<void>
  handleInterruptSnooze: () => void | Promise<void>
  handleInterruptDismiss: () => void
  handleResumeRetry: () => Promise<void>
  clearResumeError: () => void
}

type ChatSendMessage = (
  message: { text: string },
  options?: { body?: Record<string, unknown> }
) => Promise<unknown>

type StreamRuntimeRefs = {
  handleDataPart: (dataPart: unknown) => void
  handleFinish: (options: { message: { id: string } }) => void
  markStreamTurnStarted: (startedAtMs: number) => void
  sendChatMessage: ChatSendMessage
  stopStreaming: () => void
}

const EMPTY_RECAP_STORE: ChatRouteExperience["setRecapArtifacts"] = () => undefined

export function useChatRouteExperience(): ChatRouteExperience {
  useSessionPersistence()
  useUsageMonitor()

  const { user } = useAuth()
  const platform = usePlatformSignal()

  const conversationId = useChatStore((state) => state.conversationId)
  const bindRouteRuntime = useChatStore((state) => state.bindRouteRuntime)
  const unbindRouteRuntime = useChatStore((state) => state.unbindRouteRuntime)
  const syncRouteRuntimeState = useChatStore((state) => state.syncRouteRuntimeState)

  const setRecapArtifacts = useRecapStore((state) => state.setArtifacts)
  const getRecapArtifacts = useRecapStore((state) => state.getArtifacts)
  const recapArtifacts = useRecapStore((state) =>
    conversationId ? state.artifacts[conversationId] : undefined
  )
  const chatArtifacts = useMemo(
    () => mapRecapArtifactsToRitualArtifacts(recapArtifacts),
    [recapArtifacts]
  )
  const [builderArtifact, setBuilderArtifact] = useState<BuilderArtifactV1 | null>(recapArtifacts?.builderArtifact ?? null)
  const [builderTask, setBuilderTask] = useState<BuilderTaskV1 | null>(null)
  const [isCancellingBuilderTask, setIsCancellingBuilderTask] = useState(false)
  const lastBuilderCaptureSignatureRef = useRef<string | null>(null)

  const setEmotion = useEmotionStore((state) => state.setEmotion)
  const setCurrentContext = useMessageMetadataStore((state) => state.setCurrentContext)
  const setMessageMetadata = useMessageMetadataStore((state) => state.setMessageMetadata)
  const activeThreadId = useMessageMetadataStore((state) => state.currentThreadId || undefined)
  const activeThreadSessionId = useMessageMetadataStore((state) => state.currentSessionId || undefined)
  const showToast = useUiStore((state) => state.showToast)
  const showUsageLimitModal = useUsageLimitStore((state) => state.showModal)
  const recordConnectivityFailure = useConnectivityStore((state) => state.recordFailure)
  const recordConnectivitySuccess = useConnectivityStore((state) => state.recordSuccess)

  const [resumeError, setResumeError] = useState<string | null>(null)
  const [resumeRetryOptionId, setResumeRetryOptionId] = useState<string | null>(null)

  const {
    pendingInterrupt,
    interruptQueue,
    isResuming,
    handleInterruptSelect,
    handleInterruptSnooze,
    handleInterruptDismiss,
    setInterrupt,
  } = useInterrupt({
    sessionId: conversationId || "chat_pending",
    threadId: undefined,
    presetContext: "life",
    sessionType: "chat",
    onResumeSuccess: (response) => {
      setResumeError(null)
      const responseText = (response || "").trim()
      if (!responseText) return

      useChatStore.setState((state) => ({
        messages: [
          ...state.messages,
          {
            id: `interrupt-resume-${Date.now()}`,
            role: "sophia",
            content: responseText,
            createdAt: Date.now(),
            status: "complete",
            source: "text",
          },
        ],
      }))
    },
    onResumeError: (error) => {
      if (error.message === "INTERRUPT_EXPIRED") {
        setResumeRetryOptionId(null)
        setResumeError("This choice expired. Ask Sophia to bring it back.")
        return
      }

      setResumeError("Sophia couldn't resume that yet. Try again.")
    },
  })

  const clearResumeError = useCallback(() => {
    setResumeError(null)
  }, [])

  const handleInterruptSelectWithRetry = useCallback(async (optionId: string) => {
    setResumeRetryOptionId(optionId)
    setResumeError(null)
    await handleInterruptSelect(optionId)
  }, [handleInterruptSelect])

  const handleResumeRetry = useCallback(async () => {
    if (!resumeRetryOptionId) return
    await handleInterruptSelectWithRetry(resumeRetryOptionId)
  }, [handleInterruptSelectWithRetry, resumeRetryOptionId])

  const handleResolvedInterruptDismiss = useCallback(() => {
    handleInterruptDismiss()
    clearResumeError()
  }, [clearResumeError, handleInterruptDismiss])

  const handleStreamArtifacts = useCallback((artifacts: Record<string, unknown>) => {
    applyChatRouteArtifacts({
      artifacts,
      conversationId,
      setArtifacts: setRecapArtifacts,
      getArtifacts: getRecapArtifacts,
      setEmotion,
    })
  }, [conversationId, getRecapArtifacts, setEmotion, setRecapArtifacts])

  useEffect(() => {
    setBuilderArtifact(recapArtifacts?.builderArtifact ?? null)
    setBuilderTask(null)
    setIsCancellingBuilderTask(false)
    lastBuilderCaptureSignatureRef.current = null
  }, [conversationId, recapArtifacts?.builderArtifact])

  useEffect(() => {
    if (!builderTask) {
      return
    }

    const signature = JSON.stringify(builderTask)
    if (signature === lastBuilderCaptureSignatureRef.current) {
      return
    }

    lastBuilderCaptureSignatureRef.current = signature
    recordSophiaCaptureEvent({
      category: "builder",
      name: `task-${builderTask.phase}`,
      payload: builderTask,
    })
  }, [builderTask])

  const clearBuilderTask = useCallback(() => {
    setBuilderTask(null)
  }, [])

  const cancelBuilderTask = useCallback(async () => {
    if (!builderTask?.taskId || builderTask.phase !== "running" || isCancellingBuilderTask) {
      return
    }

    setIsCancellingBuilderTask(true)

    try {
      const response = await requestBuilderTaskCancellation(builderTask.taskId)
      setBuilderTask((currentTask) => {
        if (currentTask?.taskId !== builderTask.taskId) {
          return currentTask
        }

        return {
          ...currentTask,
          phase: "cancelled",
          detail: response.detail || "Builder was cancelled before finishing the deliverable.",
        }
      })
      showToast({
        message: "Builder cancelled.",
        variant: "info",
        durationMs: 2400,
      })
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : "Could not cancel Builder right now.",
        variant: "warning",
        durationMs: 3200,
      })
    } finally {
      setIsCancellingBuilderTask(false)
    }
  }, [builderTask, isCancellingBuilderTask, showToast])

  const handleBuilderArtifact = useCallback((nextBuilderArtifact: BuilderArtifactV1 | null) => {
    setBuilderArtifact(nextBuilderArtifact)
    if (nextBuilderArtifact) {
      setBuilderTask((currentTask) => currentTask
        ? {
            ...currentTask,
            phase: 'completed',
            detail: currentTask.detail || 'Deliverable ready.',
          }
        : currentTask)
    }

    const activeConversationId = useChatStore.getState().conversationId
    if (!activeConversationId || !nextBuilderArtifact) {
      return
    }

    const previousArtifacts = useRecapStore.getState().getArtifacts(activeConversationId)
    useRecapStore.getState().setArtifacts(activeConversationId, {
      sessionId: previousArtifacts?.sessionId || activeConversationId,
      threadId: previousArtifacts?.threadId || activeThreadId || activeConversationId,
      sessionType: previousArtifacts?.sessionType || 'chat',
      contextMode: previousArtifacts?.contextMode || 'life',
      startedAt: previousArtifacts?.startedAt,
      endedAt: previousArtifacts?.endedAt,
      takeaway: previousArtifacts?.takeaway,
      reflectionCandidate: previousArtifacts?.reflectionCandidate,
      memoryCandidates: previousArtifacts?.memoryCandidates,
      builderArtifact: nextBuilderArtifact,
      status: previousArtifacts?.status || 'ready',
    })
  }, [activeThreadId])

  useEffect(() => {
    if (!builderTask?.taskId || builderTask.phase !== 'running') {
      return
    }

    const activeTaskId = builderTask.taskId
    let cancelled = false
    let timeoutId: ReturnType<typeof window.setTimeout> | null = null

    const pollTaskStatus = async () => {
      try {
        const status = await getBuilderTaskStatus(activeTaskId)
        if (cancelled) {
          return
        }

        const nextBuilderArtifact = getBuilderArtifactFromStatus(status)
        if (nextBuilderArtifact) {
          handleBuilderArtifact(nextBuilderArtifact)
        }

        setBuilderTask((currentTask) => {
          if (currentTask?.taskId !== activeTaskId) {
            return currentTask
          }

          return mergeBuilderTaskStatus(currentTask, status)
        })

        if (getBuilderTaskPhaseFromStatus(status.status) !== 'running') {
          return
        }
      } catch (error) {
        if (cancelled) {
          return
        }

        if (error instanceof Error && error.message.includes('Task not found')) {
          setBuilderTask((currentTask) => {
            if (currentTask?.taskId !== activeTaskId || currentTask.phase !== 'running') {
              return currentTask
            }

            return {
              ...currentTask,
              phase: 'failed',
              detail: 'Builder task state disappeared before completion.',
            }
          })
          return
        }
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(() => {
          void pollTaskStatus()
        }, 2000)
      }
    }

    void pollTaskStatus()

    return () => {
      cancelled = true
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [builderTask?.phase, builderTask?.taskId, handleBuilderArtifact])

  const runtimeRefs = useRef<StreamRuntimeRefs>({
    handleDataPart: () => undefined,
    handleFinish: () => undefined,
    markStreamTurnStarted: () => undefined,
    sendChatMessage: async () => undefined,
    stopStreaming: () => undefined,
  })
  const timestampsRef = useRef<Map<string, number>>(new Map())
  const lastUserTextRef = useRef<string | null>(null)

  const routeSendMessage = useCallback(async ({ text }: { text: string }) => {
    const resolvedConversationId =
      useChatStore.getState().conversationId ||
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `chat_${Date.now()}`)

    if (!useChatStore.getState().conversationId) {
      useChatStore.setState({ conversationId: resolvedConversationId })
    }

    const matchingThreadId = activeThreadSessionId === resolvedConversationId
      ? activeThreadId
      : undefined

    lastUserTextRef.current = text
    runtimeRefs.current.markStreamTurnStarted(Date.now())

    await runtimeRefs.current.sendChatMessage(
      { text },
      {
        body: buildChatRouteBody({
          conversationId: resolvedConversationId,
          userId: user?.id,
          threadId: matchingThreadId,
        }),
      }
    )
  }, [activeThreadId, activeThreadSessionId, user?.id])

  const routeRetry = useCallback(async () => {
    const currentState = useChatStore.getState()
    const lastUserMessage = selectLastUserMessage(
      currentState.messages,
      currentState.lastUserTurnId
    )
    const message = lastUserTextRef.current || lastUserMessage?.content

    if (!message) {
      return
    }

    await routeSendMessage({ text: message })
  }, [routeSendMessage])

  const routeRecover = useCallback(async () => {
    const state = useChatStore.getState()
    if (!isRecoverableStreamStatus(state.streamStatus)) {
      logger.debug("ChatRouteExperience", "Recovery skipped", {
        streamStatus: state.streamStatus,
      })
      return
    }

    const connectivity = useConnectivityStore.getState()
    if (!connectivity.isOnline()) {
      logger.debug("ChatRouteExperience", "Recovery skipped while offline")
      return
    }

    const lastUserMessage = selectLastUserMessage(state.messages, state.lastUserTurnId)
    if (!lastUserMessage || !state.conversationId) {
      return
    }

    if (!shouldAttemptRecovery(state.conversationId, lastUserMessage.content)) {
      logger.debug("ChatRouteExperience", "Recovery conditions not met")
      return
    }

    const disconnectedAt = Date.now() - 5000
    const startedAt = Date.now()

    try {
      const result = await recoverFromDisconnect({
        sessionId: state.conversationId,
        lastUserMessage: lastUserMessage.content,
        disconnectedAt,
      })

      emitRecoveryTelemetry({
        sessionId: state.conversationId,
        disconnectedAt,
        recoveryResult: result.reason,
        durationMs: Date.now() - startedAt,
        hadExistingResponse: !result.shouldRetry,
      })

      if (!result.shouldRetry && result.existingResponse) {
        useChatStore.setState((currentState) => ({
          messages: applyRecoveredResponse(currentState.messages, {
            existingResponse: result.existingResponse,
            existingMessageId: result.existingMessageId,
          }),
          isLocked: false,
          activeReplyId: undefined,
          lastError: undefined,
          streamStatus: "idle",
          streamAttempt: 0,
          lastUserTurnId: undefined,
          lastCompletedTurnId: result.existingMessageId ?? currentState.lastCompletedTurnId,
        }))

        emitChatStreamRecovered(result.existingMessageId)
        usePresenceStore.getState().settleToRestingSoon()
        return
      }

      useChatStore.setState({
        streamStatus: "streaming",
        streamAttempt: 1,
        lastError: undefined,
      })
      await routeRetry()
    } catch (error) {
      logger.logError(error, {
        component: "ChatRouteExperience",
        action: "recover",
        metadata: {
          conversationId: state.conversationId,
        },
      })
    }
  }, [routeRetry])

  const routeStop = useCallback(() => {
    if (builderTask?.taskId && builderTask.phase === "running") {
      void cancelBuilderTask()
    }
    runtimeRefs.current.stopStreaming()
  }, [builderTask, cancelBuilderTask])

  const companionRuntime = useCompanionRuntime({
    routeProfile: "chat",
    chat: {
      chatRequestBody: { platform },
      handleDataPart: (dataPart) => runtimeRefs.current.handleDataPart(dataPart),
      handleFinish: (options) => runtimeRefs.current.handleFinish(options),
      showUsageLimitModal,
      recordConnectivityFailure,
      showToast,
    },
    stream: {
      ingestArtifacts: handleStreamArtifacts,
      setBuilderArtifact: handleBuilderArtifact,
      setBuilderTask,
      setInterrupt,
      setCurrentContext,
      setMessageMetadata,
      sessionId: conversationId || "chat_pending",
      activeSessionId: conversationId || undefined,
      activeThreadId,
    },
    artifacts: {
      sessionId: conversationId,
      artifacts: null,
      storeArtifacts: () => undefined,
      updateSession: () => undefined,
    },
    voice: {
      userId: user?.id,
      sessionId: conversationId,
      onUserTranscriptFallback: () => undefined,
      appendAssistantMessage: (text, suppressAssistantResponse) => {
        if (suppressAssistantResponse) {
          return
        }
        useChatStore.getState().addVoiceMessage(text)
      },
      ingestArtifacts: handleStreamArtifacts,
      onRateLimitError: () => undefined,
      sendMessage: routeSendMessage,
      latestAssistantMessage: null,
      isTyping: false,
    },
  })

  useEffect(() => {
    runtimeRefs.current = {
      handleDataPart: companionRuntime.streamContract.handleDataPart,
      handleFinish: companionRuntime.streamContract.handleFinish,
      markStreamTurnStarted: companionRuntime.streamContract.markStreamTurnStarted,
      sendChatMessage: companionRuntime.chatRuntime.sendChatMessage as ChatSendMessage,
      stopStreaming: () => {
        void companionRuntime.chatRuntime.stopStreaming()
      },
    }
  }, [companionRuntime.chatRuntime, companionRuntime.streamContract])

  useEffect(() => {
    companionRuntime.voiceRuntime.setAssistantResponseSuppressedChecker(() => true)
    companionRuntime.voiceRuntime.setOnUserTranscriptHandler(() => undefined)
  }, [companionRuntime.voiceRuntime])

  useEffect(() => {
    bindRouteRuntime({
      send: routeSendMessage,
      stop: routeStop,
      retry: routeRetry,
      recover: routeRecover,
    })

    return () => {
      unbindRouteRuntime()
    }
  }, [bindRouteRuntime, routeRecover, routeRetry, routeSendMessage, routeStop, unbindRouteRuntime])

  useEffect(() => {
    const mapped = mapRouteMessagesToChatMessages(
      companionRuntime.chatRuntime.chatMessages as unknown as RouteChatMessageLike[],
      companionRuntime.chatRuntime.chatStatus,
      timestampsRef.current
    )

    syncRouteRuntimeState({
      messages: mapped,
      chatStatus: companionRuntime.chatRuntime.chatStatus,
      error: companionRuntime.chatRuntime.chatError?.message || undefined,
      conversationId: conversationId || undefined,
    })
  }, [
    companionRuntime.chatRuntime.chatError,
    companionRuntime.chatRuntime.chatMessages,
    companionRuntime.chatRuntime.chatStatus,
    conversationId,
    syncRouteRuntimeState,
  ])

  useEffect(() => {
    if (companionRuntime.chatRuntime.chatStatus === "ready") {
      recordConnectivitySuccess()
    }
  }, [companionRuntime.chatRuntime.chatStatus, recordConnectivitySuccess])

  useEffect(() => {
    if (companionRuntime.chatRuntime.chatStatus !== "error") {
      return
    }

    useChatStore.setState({
      lastError: companionRuntime.chatRuntime.chatError?.message || copy.chat.error,
      streamStatus: "error",
      isLocked: false,
    })
  }, [companionRuntime.chatRuntime.chatError, companionRuntime.chatRuntime.chatStatus])

  return {
    conversationId,
    threadId: activeThreadId,
    recapArtifacts,
    setRecapArtifacts: setRecapArtifacts || EMPTY_RECAP_STORE,
    chatArtifacts,
    builderArtifact: builderArtifact ?? recapArtifacts?.builderArtifact ?? null,
    builderTask,
    clearBuilderTask,
    cancelBuilderTask,
    isCancellingBuilderTask,
    voiceState: companionRuntime.voiceRuntime.voiceState,
    pendingInterrupt,
    interruptQueue,
    isResuming,
    resumeError,
    canRetryResume: Boolean(resumeRetryOptionId),
    handleInterruptSelect: handleInterruptSelectWithRetry,
    handleInterruptSnooze,
    handleInterruptDismiss: handleResolvedInterruptDismiss,
    handleResumeRetry,
    clearResumeError,
  }
}