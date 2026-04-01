"use client"

import { create } from "zustand"
import { streamConversation } from "../lib/stream-conversation"
import { usePresenceStore } from "./presence-store"
import { useUsageLimitStore } from "./usage-limit-store"
import { copy } from "../copy"
import type { UsageLimitInfo } from "../types/rate-limits"
import { logger } from "../lib/error-logger"
import type { ChatMessage } from "../types"
import { useUiStore } from "./ui-store"
import { createMessageId } from "../lib/utils"
import { recoverFromDisconnect, shouldAttemptRecovery, emitRecoveryTelemetry } from "../lib/stream-recovery"
import { useConnectivityStore } from "./connectivity-store"
import {
  emitChatMessageReceived,
  emitChatMessageSent,
  emitChatStreamChunk,
  emitChatStreamComplete,
  emitChatStreamError,
  emitChatStreamReconnected,
  emitChatStreamReconnecting,
  emitChatStreamRecovered,
  emitChatStreamStart,
} from "./chat-store-events"
import {
  applyRecoveredResponse,
  isRecoverableStreamStatus,
  isRetryableStreamStatus,
  removeMessageById,
  selectLastUserMessage,
  selectRetryPlaceholder,
} from "./chat-store-recovery-policies"
import {
  parseDonePayload,
  parseFeedbackGateMeta,
  parsePresenceMeta,
  parseUsageLimitInfoMeta,
} from "./chat-store-payload-parsers"

// Re-export ChatMessage for backwards compatibility
export type { ChatMessage }

type FeedbackGate = {
  turnId: string
  allowed: boolean
  emotionalWeight?: number | null
}

// Phase 4 Week 4: Stream lifecycle states
export type StreamStatus = "idle" | "streaming" | "reconnecting" | "interrupted" | "cancelled" | "error"

type ChatRuntimeMode = "legacy" | "ai-sdk"

type AiSdkRuntimeBridge = {
  send: (params: { text: string }) => Promise<void>
  stop: () => void
  retry: () => Promise<void> | void
}

type ChatStore = {
  messages: ChatMessage[]
  composerValue: string
  isLocked: boolean
  conversationId?: string
  activeReplyId?: string
  lastError?: string
  feedbackGate?: FeedbackGate
  sessionFeedback?: {
    open: boolean
    turnId?: string
  }
  lastCompletedTurnId?: string
  abortController?: AbortController
  isLoadingHistory: boolean
  runtimeMode: ChatRuntimeMode
  aiSdkRuntime?: AiSdkRuntimeBridge
  // Phase 4 Week 4: Stream lifecycle
  streamStatus: StreamStatus
  streamAttempt: number
  lastUserTurnId?: string
  setComposerValue: (value: string) => void
  sendMessage: (override?: string) => Promise<void>
  cancelStream: () => void
  retryStream: () => void
  dismissInterrupted: () => void
  attemptRecovery: () => Promise<void>
  applyQuickPrompt: (prompt: string) => void
  clearError: () => void
  setFeedbackGate: (gate?: FeedbackGate) => void
  acknowledgeFeedback: (turnId: string) => void
  openSessionFeedback: (turnId: string) => void
  closeSessionFeedback: () => void
  addVoiceMessage: (content: string, audioUrl?: string) => void
  addUserVoiceMessage: (content: string) => void
  // Session persistence
  loadSession: (sessionId: string) => Promise<boolean>
  clearSession: () => void
  startNewSession: () => void
  bindAiSdkRuntime: (bridge: AiSdkRuntimeBridge) => void
  unbindAiSdkRuntime: () => void
  syncAiSdkState: (state: {
    messages: ChatMessage[]
    chatStatus: "submitted" | "streaming" | "ready" | "error"
    error?: string | null
    conversationId?: string
  }) => void
  _resetStreamState: (abortController?: AbortController) => {
    isLocked: boolean
    activeReplyId?: string
    abortController?: AbortController
    streamStatus: StreamStatus
    streamAttempt: number
    lastUserTurnId?: string
  }
  // Phase 4 Week 4: Handle mid-stream restore
  markAsInterrupted: () => void
}

const createMessage = (role: ChatMessage["role"], content: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: createMessageId(),
  role,
  content,
  createdAt: Date.now(),
  ...overrides,
})

export type ChatRequestBody = {
  message: string
  conversationId?: string
  user_id?: string
  platform?: string
}

export function buildChatRequestBody(params: {
  message: string
  conversationId?: string
  userId?: string
}): ChatRequestBody {
  const message = params.message.trim()
  const payload: ChatRequestBody = { message }

  if (typeof params.conversationId === 'string' && params.conversationId.trim().length > 0) {
    payload.conversationId = params.conversationId.trim()
  }

  if (typeof params.userId === 'string' && params.userId.trim().length > 0) {
    payload.user_id = params.userId.trim()
  }

  // Derive platform from current UI mode
  const mode = useUiStore.getState().mode
  payload.platform = mode === 'voice' ? 'voice' : 'text'

  return payload
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  composerValue: "",
  isLocked: false,
  conversationId: undefined,
  activeReplyId: undefined,
  lastError: undefined,
  feedbackGate: undefined,
  sessionFeedback: { open: false },
  lastCompletedTurnId: undefined,
  abortController: undefined,
  isLoadingHistory: false,
  runtimeMode: "legacy" as ChatRuntimeMode,
  aiSdkRuntime: undefined,
  // Phase 4 Week 4: Stream lifecycle
  streamStatus: "idle" as StreamStatus,
  streamAttempt: 0,
  lastUserTurnId: undefined,
  
  // Internal helper to reset stream state and abort if needed
  _resetStreamState: (abortController?: AbortController) => {
    if (abortController) {
      abortController.abort()
    }
    return {
      isLocked: false,
      activeReplyId: undefined,
      abortController: undefined,
      streamStatus: "idle" as StreamStatus,
      streamAttempt: 0,
      lastUserTurnId: undefined,
    }
  },
  setComposerValue: (value) => set({ composerValue: value }),
  applyQuickPrompt: (prompt) => set({ composerValue: prompt }),
  clearError: () => set({ lastError: undefined }),
  setFeedbackGate: (gate) => set({ feedbackGate: gate }),
  
  // Phase 4 Week 4: Cancel keeps placeholder with "Cancelled" state
  cancelStream: () => {
    const aiSdkRuntime = get().aiSdkRuntime
    if (aiSdkRuntime) {
      aiSdkRuntime.stop()

      set((state) => ({
        messages: state.messages.map((m) =>
          m.role === "sophia" && m.status === "streaming"
            ? { ...m, status: "cancelled" as const, content: m.content || "" }
            : m
        ),
        isLocked: false,
        activeReplyId: undefined,
        abortController: undefined,
        feedbackGate: undefined,
        streamStatus: "cancelled" as StreamStatus,
        streamAttempt: 0,
      }))

      usePresenceStore.getState().setListening(false)
      usePresenceStore.getState().settleToRestingSoon()
      return
    }

    const { abortController, activeReplyId, conversationId } = get()
    if (abortController) {
      // 1. Abort the frontend fetch immediately
      abortController.abort()
      
      // 2. Notify backend to stop processing (fire-and-forget)
      if (conversationId) {
        fetch(`/api/conversation/${conversationId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }).catch(() => {
          // Ignore errors - best effort cancellation
        })
      }
      
      // 3. Keep placeholder but mark as cancelled (Phase 4 Week 4)
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === activeReplyId
            ? { ...m, status: "cancelled" as const, content: "" }
            : m
        ),
        isLocked: false,
        activeReplyId: undefined, // Clear so user can send new message
        abortController: undefined,
        feedbackGate: undefined,
        streamStatus: "cancelled" as StreamStatus,
        streamAttempt: 0,
      }))
      usePresenceStore.getState().setListening(false)
      usePresenceStore.getState().settleToRestingSoon()
    }
  },
  
  // Phase 4 Week 4: Retry from cancelled/interrupted state
  retryStream: () => {
    const aiSdkRuntime = get().aiSdkRuntime
    if (aiSdkRuntime) {
      const { streamStatus } = get()
      if (!isRetryableStreamStatus(streamStatus)) {
        return
      }

      set({
        streamStatus: "streaming" as StreamStatus,
        streamAttempt: 1,
        lastError: undefined,
      })

      void aiSdkRuntime.retry()
      return
    }

    const { lastUserTurnId, messages, streamStatus } = get()
    
    // Only retry if in retryable state
    if (!isRetryableStreamStatus(streamStatus)) {
      return
    }
    
    // Find the last user message to resend
    const lastUserMessage = selectLastUserMessage(messages, lastUserTurnId)
    
    if (!lastUserMessage) {
      logger.debug("ChatStore", "No user message to retry")
      return
    }
    
    // Check if we're offline - if so, queue instead of retry
    const connectivity = useConnectivityStore.getState()
    if (!connectivity.isOnline()) {
      logger.debug("ChatStore", "Offline - skipping retryStream queue write (session flow owns offline queue)")
      // Keep interrupted/cancelled state; session composer flow is the single owner for offline queueing.
      return
    }
    
    // Remove the cancelled/interrupted placeholder
    const cancelledPlaceholder = selectRetryPlaceholder(messages)
    
    set((state) => ({
      messages: removeMessageById(state.messages, cancelledPlaceholder?.id),
      streamStatus: "idle" as StreamStatus,
    }))
    
    // Resend the message
    get().sendMessage(lastUserMessage.content)
  },
  
  // Phase 4 Week 4: Dismiss interrupted/cancelled placeholder
  dismissInterrupted: () => {
    set((state) => ({
      messages: state.messages.filter(m => 
        m.status !== "cancelled" && m.status !== "interrupted"
      ),
      streamStatus: "idle" as StreamStatus,
      lastUserTurnId: undefined,
    }))
  },
  
  // Phase 4 Week 4: Attempt recovery from stream failure
  // Checks if backend already has the response before re-sending
  attemptRecovery: async () => {
    const { conversationId, lastUserTurnId, messages, streamStatus } = get()
    
    // Only attempt if in error/interrupted state
    if (!isRecoverableStreamStatus(streamStatus)) {
      logger.debug("ChatStore", "Recovery skipped - not in recoverable state", { streamStatus })
      return
    }
    
    // Check if we're online first
    const connectivity = useConnectivityStore.getState()
    if (!connectivity.isOnline()) {
      logger.debug("ChatStore", "Recovery skipped - still offline, will retry when online")
      return
    }
    
    // Find the last user message
    const lastUserMessage = selectLastUserMessage(messages, lastUserTurnId)
    
    if (!shouldAttemptRecovery(conversationId ?? null, lastUserMessage?.content ?? null)) {
      logger.debug("ChatStore", "Recovery conditions not met, falling back to manual retry")
      return
    }
    
    const disconnectedAt = Date.now() - 5000 // Estimate disconnect time
    const startTime = Date.now()
    
    logger.debug("ChatStore", "Attempting stream recovery", {
      sessionId: conversationId,
      userMessage: lastUserMessage?.content?.substring(0, 50),
    })
    
    try {
      const result = await recoverFromDisconnect({
        sessionId: conversationId!,
        lastUserMessage: lastUserMessage!.content,
        disconnectedAt,
      })
      
      // Emit telemetry
      emitRecoveryTelemetry({
        sessionId: conversationId!,
        disconnectedAt,
        recoveryResult: result.reason,
        durationMs: Date.now() - startTime,
        hadExistingResponse: !result.shouldRetry,
      })
      
      if (!result.shouldRetry && result.existingResponse) {
        // Found existing response - display it
        logger.debug("ChatStore", "Recovery found existing response", {
          messageId: result.existingMessageId,
          responsePreview: result.existingResponse.substring(0, 50),
        })
        
        // Update the interrupted/error message with the recovered content
        set((state) => ({
          messages: applyRecoveredResponse(state.messages, {
            existingResponse: result.existingResponse,
            existingMessageId: result.existingMessageId,
          }),
          streamStatus: "idle" as StreamStatus,
          lastUserTurnId: undefined,
        }))
        
        // 🔔 Emit recovery event
        emitChatStreamRecovered(result.existingMessageId)
        
        usePresenceStore.getState().settleToRestingSoon()
      } else {
        // No response found - trigger retry
        logger.debug("ChatStore", "Recovery: no existing response, retrying", { reason: result.reason })
        get().retryStream()
      }
    } catch (error) {
      logger.logError(error, {
        component: "ChatStore",
        action: "attemptRecovery",
        sessionId: conversationId,
      })
      // Recovery failed - user can still manually retry
    }
  },
  
  // Phase 4 Week 4: Mark current stream as interrupted (for restore)
  markAsInterrupted: () => {
    const { activeReplyId, isLocked } = get()
    
    if (isLocked && activeReplyId) {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === activeReplyId
            ? { ...m, status: "interrupted" as const }
            : m
        ),
        isLocked: false,
        activeReplyId: undefined,
        abortController: undefined,
        streamStatus: "interrupted" as StreamStatus,
      }))
    }
  },
  
  acknowledgeFeedback: (turnId) =>
    set((state) => {
      const updates: Partial<ChatStore> = {}
      if (state.feedbackGate?.turnId === turnId) {
        updates.feedbackGate = undefined
      }
      if (state.sessionFeedback?.turnId === turnId) {
        updates.sessionFeedback = { open: false, turnId: undefined }
      }
      return updates
    }),
  openSessionFeedback: (turnId) => set({ sessionFeedback: { open: true, turnId } }),
  closeSessionFeedback: () => set({ sessionFeedback: { open: false, turnId: undefined } }),
  setLastCompletedTurn: (turnId: string | undefined) => set({ lastCompletedTurnId: turnId }),
  sendMessage: async (override) => {
    const text = (override ?? get().composerValue).trim()
    if (!text || get().isLocked) return

    const aiSdkRuntime = get().aiSdkRuntime
    if (aiSdkRuntime) {
      set({
        composerValue: "",
        lastError: undefined,
        feedbackGate: undefined,
        streamStatus: "streaming" as StreamStatus,
        streamAttempt: 1,
      })

      try {
        await aiSdkRuntime.send({ text })
      } catch (error) {
        logger.error(error, {
          component: 'ChatStore',
          action: 'sendMessage.ai_sdk_runtime',
        })

        set({
          isLocked: false,
          activeReplyId: undefined,
          abortController: undefined,
          lastError: error instanceof Error ? error.message : copy.chat.error,
          feedbackGate: undefined,
          streamStatus: "error" as StreamStatus,
        })
      }

      return
    }

    // Add breadcrumb for message send
    logger.addBreadcrumb("User sent message", {
      messageLength: text.length,
      hasOverride: !!override,
    })

    // 💜 Block if user is at 100% usage limit
    const usageStore = useUsageLimitStore.getState()
    if (usageStore.isAtLimit) {
      // Show modal if not already open
      if (!usageStore.isOpen && usageStore.currentUsage) {
        const reason = usageStore.currentUsage.textPercent >= 100 ? "text" : "voice"
        const limitInfo: UsageLimitInfo = {
          reason,
          plan_tier: "FREE", // Will be updated by usage monitor
          limit: 0,
          used: 0,
        }
        usageStore.showModal(limitInfo)
      }
      return // Block the request
    }

    const userMessage = createMessage("user", text)
    const replyId = createMessageId()

    // 🔔 Emit message sent event
    emitChatMessageSent({
      id: userMessage.id,
      content: text,
      role: "user",
      source: "text",
    })

    // Accumulate tokens in memory but don't show them until done
    let accumulatedContent = ""

    // Create AbortController for this stream
    const abortController = new AbortController()

    set((state) => ({
      messages: [...state.messages, userMessage, {
        id: replyId,
        role: "sophia",
        content: "", // Start empty - will only show when done
        createdAt: Date.now(),
        status: "streaming",
        turnId: replyId,
      }],
      composerValue: "",
      isLocked: true,
      activeReplyId: replyId,
      lastError: undefined,
      feedbackGate: undefined,
      abortController,
      // Phase 4 Week 4: Track stream lifecycle
      streamStatus: "streaming" as StreamStatus,
      streamAttempt: 1,
      lastUserTurnId: userMessage.id,
    }))

    // 🔔 Emit stream start event
    emitChatStreamStart(get().conversationId ?? "new")

    usePresenceStore.getState().setListening(true)
    let sawFeedbackGate = false

    // 💜 Get user_id from usage store (set by useUsageMonitor)
    // The usage monitor already has access to the user, so we can get it from there
    const userId = useUsageLimitStore.getState().currentUsage?.user_id
    
    try {
      await streamConversation({
        body: buildChatRequestBody({
          message: text,
          conversationId: get().conversationId,
          userId, // 💜 Pass user_id for rate limiting
        }),
        signal: abortController.signal,
      }, {
        onCancel: () => {
          // Stream was cancelled by user - cleanup already done in cancelStream
        },
        onUsageLimit: (error) => {
          // Only show modal when limit is reached (100%)
          // Progressive alerts (hints/toasts) are handled by backend meta events
          useUsageLimitStore.getState().showModal({
            reason: error.reason,
            plan_tier: error.plan_tier,
            limit: error.limit,
            used: error.used,
          })
          // Clean up UI state
          set((state) => ({
            messages: state.messages.filter((m) => m.id !== replyId),
            isLocked: false,
            activeReplyId: undefined,
            feedbackGate: undefined,
          }))
          usePresenceStore.getState().setListening(false)
          usePresenceStore.getState().settleToRestingSoon()
        },
        onMeta: (meta) => {
          const conversationId = typeof meta?.conversationId === "string" ? meta.conversationId : undefined
          if (conversationId && conversationId !== get().conversationId) {
            set({ conversationId })
          }

          const presence = parsePresenceMeta(meta)
          if (presence) {
            usePresenceStore.getState().setMetaStage(presence.status, presence.detail)
          }

          const feedbackGate = parseFeedbackGateMeta(meta, replyId)
          if (feedbackGate) {
            sawFeedbackGate = sawFeedbackGate || feedbackGate.allowed
            get().setFeedbackGate({
              turnId: feedbackGate.turnId,
              allowed: feedbackGate.allowed,
              emotionalWeight: feedbackGate.emotionalWeight,
            })
          }

          // Handle progressive usage alerts from backend
          const usageLimitInfo = parseUsageLimitInfoMeta(meta)
          if (usageLimitInfo) {
            if (usageLimitInfo.limit <= 0) {
              return
            }

            useUsageLimitStore.getState().applyUsageInfo({
              reason: usageLimitInfo.reason,
              plan_tier: usageLimitInfo.plan_tier,
              limit: usageLimitInfo.limit,
              used: usageLimitInfo.used,
            })
          }
        },
        onToken: (token) => {
          // Accumulate tokens but don't update UI - user won't see tokens
          accumulatedContent += token
          usePresenceStore.getState().setListening(false)
          usePresenceStore.getState().setMetaStage("thinking")
          
          // 🔔 Emit stream chunk event
          emitChatStreamChunk(replyId, token)
          // Don't update message content - wait for onDone
        },
        onDone: (payload) => {
          // Phase 4 Week 4: Guard against duplicate "done" events
          const currentState = get()
          if (currentState.lastCompletedTurnId === replyId) {
            logger.debug("ChatStore", "Ignoring duplicate done event", { replyId })
            return
          }
          
          // Ignore if message already completed/cancelled/interrupted
          const existingMessage = currentState.messages.find(m => m.id === replyId)
          if (existingMessage?.status === "complete" || 
              existingMessage?.status === "cancelled" || 
              existingMessage?.status === "interrupted") {
            logger.debug("ChatStore", "Ignoring done for already-finished message", { 
              replyId, 
              status: existingMessage.status 
            })
            return
          }
          
          const parsedDonePayload = parseDonePayload(payload, replyId)
          const payloadMessage = parsedDonePayload.message
          const payloadAudioUrl = parsedDonePayload.audioUrl
          const payloadConversationId = parsedDonePayload.conversationId
          const payloadTurnId = parsedDonePayload.turnId

          // Show the final reply - use accumulated content or payload message
          const finalContent = payloadMessage ?? accumulatedContent.trim()
          set((state) => {
            const currentMessage = state.messages.find(m => m.id === replyId)
            const finalText = finalContent || currentMessage?.content || ""
            return {
              messages: state.messages.map((message) =>
                message.id === replyId
                  ? {
                      ...message,
                      status: "complete",
                      content: finalText,
                      audioUrl: payloadAudioUrl,
                    }
                  : message
              ),
              isLocked: false,
              activeReplyId: undefined,
              abortController: undefined,
              conversationId: payloadConversationId ?? state.conversationId,
              feedbackGate: state.feedbackGate?.turnId === replyId ? undefined : state.feedbackGate,
              lastCompletedTurnId: replyId,
              // Phase 4 Week 4: Reset stream status
              streamStatus: "idle" as StreamStatus,
              streamAttempt: 0,
            }
          })
          
          // � Update usage from backend response (reduces need for polling)
          if (parsedDonePayload.usage) {
            useUsageLimitStore.getState().updateFromBackendUsage(parsedDonePayload.usage)
          }
          
          // �🔔 Emit stream complete event
          emitChatStreamComplete({
            id: replyId,
            finalContent: finalContent,
            turnId: payloadTurnId,
          })
          
          // 🔔 Emit message received event
          emitChatMessageReceived({
            id: replyId,
            content: finalContent,
            role: "sophia",
            turnId: payloadTurnId,
            audioUrl: payloadAudioUrl,
          })
          
          // TEMPORARILY DISABLED - Backend endpoint not implemented yet
          // if (!sawFeedbackGate) {
          //   get().openSessionFeedback(replyId)
          // }
          usePresenceStore.getState().setListening(false)
          usePresenceStore.getState().settleToRestingSoon()
          // Usage refresh is handled by Event Bus listener in useUsageMonitor
        },
        onError: (payload) => {
          // 🔔 Emit stream error event
          emitChatStreamError(payload?.message ?? copy.chat.error)
          
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === replyId
                ? {
                    ...message,
                    status: "error",
                    content: message.content || copy.chat.error,
                  }
                : message
            ),
            isLocked: false,
            activeReplyId: undefined,
            abortController: undefined,
            lastError: payload?.message ?? copy.chat.error,
            feedbackGate: undefined,
            // Phase 4 Week 4: Set error state
            streamStatus: "error" as StreamStatus,
          }))
          usePresenceStore.getState().setListening(false)
          usePresenceStore.getState().settleToRestingSoon()
        },
        // Phase 4 Week 4: Reconnect callbacks for UX
        onReconnecting: (attempt, maxRetries) => {
          logger.debug("ChatStore", `SSE reconnecting attempt ${attempt}/${maxRetries}`, { replyId })
          set({
            streamStatus: "reconnecting" as StreamStatus,
            streamAttempt: attempt,
          })
          // 🔔 Emit reconnecting event
          emitChatStreamReconnecting(attempt, maxRetries)
        },
        onReconnected: () => {
          logger.debug("ChatStore", "SSE reconnected successfully", { replyId })
          set({
            streamStatus: "streaming" as StreamStatus,
          })
          // 🔔 Emit reconnected event
          emitChatStreamReconnected()
        },
      })
    } catch (error) {
      // Ignore abort errors - they're handled in onCancel
      if (error instanceof DOMException && error.name === "AbortError") {
        return
      }
      
      logger.error(error, {
        component: 'ChatStore',
        action: 'sendMessage',
        metadata: {
          conversationId: get().conversationId,
          messageLength: text.length,
        },
      })
      
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === replyId
            ? {
                ...message,
                status: "error",
                content: message.content || copy.chat.error,
              }
            : message
        ),
        isLocked: false,
        activeReplyId: undefined,
        abortController: undefined,
        lastError: copy.chat.error,
        feedbackGate: undefined,
      }))
      usePresenceStore.getState().setListening(false)
      usePresenceStore.getState().settleToRestingSoon()
    }
  },
  addVoiceMessage: (content, audioUrl) => {
    const voiceMessage = createMessage("sophia", content, {
      source: "voice",
      status: "complete",
      audioUrl,
    })
    
    // 🔔 Emit message received event for voice
    emitChatMessageReceived({
      id: voiceMessage.id,
      content: content,
      role: "sophia",
      audioUrl: audioUrl,
    })
    
    set((state) => ({
      messages: [...state.messages, voiceMessage],
    }))
  },

  addUserVoiceMessage: (content) => {
    if (!content.trim()) return
    
    const userVoiceMessage = createMessage("user", content, {
      source: "voice",
      status: "complete",
    })
    
    set((state) => ({
      messages: [...state.messages, userVoiceMessage],
    }))
  },

  // Session persistence methods
  // NOTE: Backend session loading endpoint not implemented yet
  // This method is kept for future use but currently returns false
  loadSession: async (_sessionId: string) => {
    // Backend endpoint /api/v1/conversations/sessions/{id} is not implemented
    // Return false to indicate session couldn't be loaded from backend
    set({ isLoadingHistory: false, lastError: "Backend session loading not implemented" })
    return false
  },
  
  clearSession: () => {
    const { abortController, _resetStreamState } = get()
    set({
      messages: [],
      conversationId: undefined,
      lastError: undefined,
      feedbackGate: undefined,
      sessionFeedback: { open: false },
      lastCompletedTurnId: undefined,
      isLoadingHistory: false,
      ..._resetStreamState(abortController),
    })
  },
  
  startNewSession: () => {
    const { abortController, _resetStreamState } = get()
    // Clear current session but keep the store ready for a new conversation
    set({
      messages: [],
      conversationId: undefined,
      lastError: undefined,
      feedbackGate: undefined,
      sessionFeedback: { open: false },
      lastCompletedTurnId: undefined,
      isLoadingHistory: false,
      ..._resetStreamState(abortController),
    })
    logger.debug('chat-store', 'Started new session')
  },

  bindAiSdkRuntime: (bridge) => {
    set({
      aiSdkRuntime: bridge,
      runtimeMode: "ai-sdk" as ChatRuntimeMode,
    })
  },

  unbindAiSdkRuntime: () => {
    set({
      aiSdkRuntime: undefined,
      runtimeMode: "legacy" as ChatRuntimeMode,
      isLocked: false,
      activeReplyId: undefined,
      abortController: undefined,
      streamStatus: "idle" as StreamStatus,
      streamAttempt: 0,
    })
  },

  syncAiSdkState: ({ messages, chatStatus, error, conversationId }) => {
    set((state) => {
      const retainedVoiceMessages = state.messages.filter((m) => m.source === "voice")
      const mergedById = new Map<string, ChatMessage>()

      for (const message of retainedVoiceMessages) {
        mergedById.set(message.id, message)
      }

      for (const message of messages) {
        mergedById.set(message.id, message)
      }

      const mergedMessages = Array.from(mergedById.values()).sort((a, b) => a.createdAt - b.createdAt)

      const isStreaming = chatStatus === "submitted" || chatStatus === "streaming"
      const activeReply = [...mergedMessages]
        .reverse()
        .find((message) => message.role === "sophia" && message.status === "streaming")

      let streamStatus: StreamStatus = "idle"
      if (chatStatus === "error") {
        streamStatus = "error"
      } else if (chatStatus === "submitted" || chatStatus === "streaming") {
        streamStatus = "streaming"
      }

      const lastCompletedAssistant = [...mergedMessages]
        .reverse()
        .find((message) => message.role === "sophia" && message.status === "complete")

      return {
        messages: mergedMessages,
        conversationId: conversationId ?? state.conversationId,
        isLocked: isStreaming,
        activeReplyId: activeReply?.id,
        lastError: error || undefined,
        streamStatus,
        streamAttempt: isStreaming ? 1 : 0,
        lastCompletedTurnId: lastCompletedAssistant?.turnId ?? state.lastCompletedTurnId,
      }
    })
  },
}))

if (process.env.NODE_ENV !== "production") {
  useChatStore.subscribe((state, prevState) => {
    if (!prevState) return

    if (state.isLocked !== prevState.isLocked) {
      console.trace("[chat-store] isLocked", prevState.isLocked, "→", state.isLocked)
    }

    if (state.messages.length !== prevState.messages.length) {
      console.trace("[chat-store] messages", prevState.messages.length, "→", state.messages.length)
    }

    if (state.lastError !== prevState.lastError) {
      console.trace("[chat-store] lastError", prevState.lastError, "→", state.lastError)
    }
  })
}
