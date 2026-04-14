"use client"

import { create } from "zustand"
import { createJSONStorage, persist } from 'zustand/middleware'

import { copy } from "../copy"
import { logger } from "../lib/error-logger"
import { createMessageId } from "../lib/utils"
import type { ChatMessage } from "../types"

import { emitChatMessageReceived } from "./chat-store-events"
import {
  isRecoverableStreamStatus,
  isRetryableStreamStatus,
} from "./chat-store-recovery-policies"
import { useConnectivityStore } from "./connectivity-store"
import { usePresenceStore } from "./presence-store"

// Re-export ChatMessage for backwards compatibility
export type { ChatMessage }

type FeedbackGate = {
  turnId: string
  allowed: boolean
  emotionalWeight?: number | null
}

// Phase 4 Week 4: Stream lifecycle states
export type StreamStatus = "idle" | "streaming" | "reconnecting" | "interrupted" | "cancelled" | "error"

type ChatRouteRuntimeBridge = {
  send: (params: { text: string }) => Promise<void>
  stop: () => void
  retry: () => Promise<void> | void
  recover: () => Promise<void> | void
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
  routeRuntime?: ChatRouteRuntimeBridge
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
  bindRouteRuntime: (bridge: ChatRouteRuntimeBridge) => void
  unbindRouteRuntime: () => void
  syncRouteRuntimeState: (state: {
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

export const useChatStore = create<ChatStore>()(persist((set, get) => ({
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
  routeRuntime: undefined,
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
    const { routeRuntime, abortController, activeReplyId } = get()
    routeRuntime?.stop()
    abortController?.abort()

    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === activeReplyId || (message.role === "sophia" && message.status === "streaming")
          ? { ...message, status: "cancelled" as const, content: message.content || "" }
          : message
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
  },
  
  // Phase 4 Week 4: Retry from cancelled/interrupted state
  retryStream: () => {
    const { routeRuntime, streamStatus } = get()
    if (!isRetryableStreamStatus(streamStatus)) {
      return
    }

    if (!routeRuntime) {
      return
    }

    set({
      streamStatus: "streaming" as StreamStatus,
      streamAttempt: 1,
      lastError: undefined,
    })

    void routeRuntime.retry()
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
  attemptRecovery: async () => {
    const { routeRuntime, streamStatus } = get()
    if (!isRecoverableStreamStatus(streamStatus)) {
      logger.debug("ChatStore", "Recovery skipped - not in recoverable state", { streamStatus })
      return
    }

    const connectivity = useConnectivityStore.getState()
    if (!connectivity.isOnline()) {
      logger.debug("ChatStore", "Recovery skipped - still offline, will retry when online")
      return
    }

    if (!routeRuntime) {
      return
    }

    set({
      streamStatus: "reconnecting" as StreamStatus,
      streamAttempt: Math.max(get().streamAttempt, 1),
    })

    await routeRuntime.recover()
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

    const { routeRuntime } = get()
    if (!routeRuntime) {
      return
    }

    set({
      composerValue: "",
      lastError: undefined,
      feedbackGate: undefined,
      streamStatus: "streaming" as StreamStatus,
      streamAttempt: 1,
    })

    try {
      await routeRuntime.send({ text })
    } catch (error) {
      logger.error(error, {
        component: 'ChatStore',
        action: 'sendMessage',
        metadata: {
          conversationId: get().conversationId,
          messageLength: text.length,
        },
      })

      set({
        isLocked: false,
        activeReplyId: undefined,
        abortController: undefined,
        lastError: copy.chat.error,
        feedbackGate: undefined,
        streamStatus: "error" as StreamStatus,
      })
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

  bindRouteRuntime: (bridge) => {
    set({ routeRuntime: bridge })
  },

  unbindRouteRuntime: () => {
    set({
      routeRuntime: undefined,
      isLocked: false,
      activeReplyId: undefined,
      abortController: undefined,
      streamStatus: "idle" as StreamStatus,
      streamAttempt: 0,
    })
  },

  syncRouteRuntimeState: ({ messages, chatStatus, error, conversationId }) => {
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

      const lastUserMessage = [...mergedMessages]
        .reverse()
        .find((message) => message.role === "user")

      return {
        messages: mergedMessages,
        conversationId: conversationId ?? state.conversationId,
        isLocked: isStreaming,
        activeReplyId: activeReply?.id,
        lastError: error || undefined,
        streamStatus,
        streamAttempt: isStreaming ? 1 : 0,
        lastUserTurnId: lastUserMessage?.id ?? state.lastUserTurnId,
        lastCompletedTurnId: lastCompletedAssistant?.turnId ?? state.lastCompletedTurnId,
      }
    })
  },
}), {
  name: 'sophia-chat-store',
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    conversationId: state.conversationId,
  }),
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
