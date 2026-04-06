/**
 * Conversation Store
 * ==================
 * 
 * Phase 4 Week 4 - Subphase 3: Conversation History Consistency
 * 
 * Dedicated store for conversation history management.
 * Separates conversation list state from active chat state.
 * 
 * Key responsibilities:
 * - Manage conversation list (local + backend)
 * - Track loading/pagination state
 * - Handle conversation switching safely
 * - Maintain recap links and session status
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { 
  archiveConversation, 
  getConversationSummaries,
  deleteConversationFromHistory,
} from "../lib/conversation-history"
import { 
  loadConversation, 
  startNewConversation,
  cancelCurrentStream,
  shouldCancelStreamOnSwitch,
  fetchBackendConversations,
} from "../lib/conversation-loader"
import { logger } from "../lib/error-logger"
import type { ConversationSummary } from "../types"
import type { 
  ConversationId, 
  BackendConversationListItem,
} from "../types/conversation-identity"

import { useChatStore } from "./chat-store"

// =============================================================================
// Types
// =============================================================================

export type ConversationSource = "local" | "backend" | "mixed"

export interface ConversationListItem extends ConversationSummary {
  source: ConversationSource
  sessionId?: string
  threadId?: string
  hasRecap?: boolean
  isActive?: boolean
}

export type ListLoadingState = "idle" | "loading" | "refreshing" | "error"
export type ConversationLoadingState = "idle" | "loading" | "error"

interface ConversationStoreState {
  // Conversation list
  conversations: ConversationListItem[]
  listLoadingState: ListLoadingState
  listError: string | null
  
  // Pagination
  hasMore: boolean
  nextCursor: string | null
  
  // Currently loading conversation
  loadingConversationId: ConversationId | null
  conversationLoadingState: ConversationLoadingState
  conversationError: string | null
  
  // Last viewed tracking (for recap alignment)
  lastViewedConversationId: ConversationId | null
  lastRecapSessionId: string | null
  
  // Actions
  refreshConversations: () => Promise<void>
  loadMoreConversations: () => Promise<void>
  loadConversation: (id: ConversationId, source?: ConversationSource) => Promise<boolean>
  startNew: () => void
  archiveCurrent: () => void
  deleteConversation: (id: ConversationId) => void
  setLastRecapSessionId: (id: string | null) => void
}

// =============================================================================
// Store
// =============================================================================

export const useConversationStore = create<ConversationStoreState>()(
  persist(
    (set, get) => ({
      // Initial state
      conversations: [],
      listLoadingState: "idle",
      listError: null,
      hasMore: false,
      nextCursor: null,
      loadingConversationId: null,
      conversationLoadingState: "idle",
      conversationError: null,
      lastViewedConversationId: null,
      lastRecapSessionId: null,

      /**
       * Refresh conversation list from both local and backend.
       */
      refreshConversations: async () => {
        set({ listLoadingState: "refreshing", listError: null })

        try {
          const pageSize = 20

          // Get local conversations
          const localSummaries = getConversationSummaries()
          const localItems: ConversationListItem[] = localSummaries.map(s => ({
            ...s,
            source: "local" as ConversationSource,
          }))

          // Try to fetch backend conversations
          let backendItems: ConversationListItem[] = []
          try {
            const backendConversations = await fetchBackendConversations({ limit: pageSize, cursor: "1" })
            backendItems = backendConversations.map(b => 
              backendConversationToListItem(b)
            )
          } catch (error) {
            // Backend fetch failed - continue with local only
            logger.debug("ConversationStore", "Backend fetch failed, using local only", { error })
          }

          // Merge local and backend, preferring backend for duplicates
          const merged = mergeConversationLists(localItems, backendItems)
          
          set({
            conversations: merged,
            listLoadingState: "idle",
            hasMore: backendItems.length >= pageSize,
            nextCursor: backendItems.length >= pageSize ? "2" : null,
          })
        } catch (error) {
          logger.logError(error, {
            component: "ConversationStore",
            action: "refreshConversations",
          })
          set({
            listLoadingState: "error",
            listError: error instanceof Error ? error.message : "Failed to load conversations",
          })
        }
      },

      /**
       * Load more conversations (pagination).
       */
      loadMoreConversations: async () => {
        const { hasMore, nextCursor, listLoadingState, conversations } = get()
        
        if (!hasMore || listLoadingState === "loading" || !nextCursor) {
          return
        }

        set({ listLoadingState: "loading" })

        try {
          const pageSize = 20
          const backendConversations = await fetchBackendConversations({ 
            limit: pageSize,
            cursor: nextCursor,
          })
          
          const newItems = backendConversations.map(b => 
            backendConversationToListItem(b)
          )

          // Append and dedupe
          const allItems = [...conversations, ...newItems]
          const deduped = dedupeConversationList(allItems)

          set({
            conversations: deduped,
            listLoadingState: "idle",
            hasMore: newItems.length >= pageSize,
            nextCursor: newItems.length >= pageSize && nextCursor
              ? String(Number(nextCursor) + 1)
              : null,
          })
        } catch (error) {
          logger.logError(error, {
            component: "ConversationStore",
            action: "loadMoreConversations",
          })
          set({ listLoadingState: "idle" })
        }
      },

      /**
       * Load a specific conversation - THE SAFE WAY.
       * Handles stream cancellation, deduplication, and atomic state updates.
       */
      loadConversation: async (id: ConversationId, source: ConversationSource = "local") => {
        const { loadingConversationId } = get()
        
        // Already loading this conversation
        if (loadingConversationId === id) {
          return false
        }

        // Step 1: Cancel any in-flight stream
        if (shouldCancelStreamOnSwitch()) {
          logger.debug("ConversationStore", "Cancelling stream before switching conversation", { id })
          cancelCurrentStream()
        }

        // Step 2: Archive current conversation if it has messages
        get().archiveCurrent()

        // Step 3: Set loading state
        set({
          loadingConversationId: id,
          conversationLoadingState: "loading",
          conversationError: null,
        })

        try {
          // Step 4: Load the conversation (idempotent)
          const result = await loadConversation(
            id, 
            source === "backend" ? "backend" : "local"
          )

          if (result.success) {
            set({
              loadingConversationId: null,
              conversationLoadingState: "idle",
              lastViewedConversationId: id,
            })
            return true
          } else {
            set({
              loadingConversationId: null,
              conversationLoadingState: "error",
              conversationError: result.error ?? "Failed to load conversation",
            })
            return false
          }
        } catch (error) {
          logger.logError(error, {
            component: "ConversationStore",
            action: "loadConversation",
            conversationId: id,
          })
          set({
            loadingConversationId: null,
            conversationLoadingState: "error",
            conversationError: error instanceof Error ? error.message : "Failed to load conversation",
          })
          return false
        }
      },

      /**
       * Start a new conversation - safe cleanup.
       */
      startNew: () => {
        // Archive current first
        get().archiveCurrent()
        
        // Cancel any streams
        if (shouldCancelStreamOnSwitch()) {
          cancelCurrentStream()
        }

        // Clear state
        startNewConversation()
        
        set({
          lastViewedConversationId: null,
          conversationLoadingState: "idle",
          conversationError: null,
        })
      },

      /**
       * Archive current conversation to history.
       */
      archiveCurrent: () => {
        const chatStore = useChatStore.getState()
        const { conversationId, messages } = chatStore
        
        if (conversationId && messages.length >= 2) {
          archiveConversation(conversationId, messages)
          
          // Update local conversations list
          const localSummaries = getConversationSummaries()
          const localItems: ConversationListItem[] = localSummaries.map(s => ({
            ...s,
            source: "local" as ConversationSource,
          }))
          
          // Merge with existing backend items
          const { conversations } = get()
          const backendItems = conversations.filter(c => c.source === "backend")
          const merged = mergeConversationLists(localItems, backendItems)
          
          set({ conversations: merged })
        }
      },

      /**
       * Delete a conversation from history.
       */
      deleteConversation: (id: ConversationId) => {
        // Delete from local storage
        deleteConversationFromHistory(id)
        
        // Remove from list
        set(state => ({
          conversations: state.conversations.filter(c => c.id !== id),
        }))
      },

      /**
       * Track last recap session for alignment.
       */
      setLastRecapSessionId: (id: string | null) => {
        set({ lastRecapSessionId: id })
      },
    }),
    {
      name: "sophia-conversation-store",
      version: 1,
      partialize: (state) => ({
        // Only persist these fields
        lastViewedConversationId: state.lastViewedConversationId,
        lastRecapSessionId: state.lastRecapSessionId,
      }),
    }
  )
)

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert backend conversation to list item format.
 */
function backendConversationToListItem(
  backend: BackendConversationListItem
): ConversationListItem {
  return {
    id: backend.conversation_id || backend.session_id,
    title: backend.title || generateTitleFromPreview(backend.preview),
    preview: backend.preview || backend.last_message_preview || "",
    messageCount: backend.turn_count * 2, // Rough estimate
    createdAt: new Date(backend.created_at).getTime(),
    updatedAt: new Date(backend.updated_at).getTime(),
    inputMode: "text", // Default, could be parsed from meta
    voiceCount: 0,
    textCount: backend.turn_count,
    source: "backend",
    sessionId: backend.session_id,
    threadId: backend.thread_id,
    hasRecap: backend.has_recap,
    isActive: backend.is_active,
  }
}

/**
 * Generate a title from preview text.
 */
function generateTitleFromPreview(preview?: string): string {
  if (!preview) return "Conversation"
  const text = preview.trim()
  if (text.length <= 40) return text
  const truncated = text.slice(0, 40)
  const lastSpace = truncated.lastIndexOf(" ")
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "..."
}

/**
 * Merge local and backend conversation lists.
 * Backend takes priority for duplicates (has more metadata).
 */
function mergeConversationLists(
  local: ConversationListItem[],
  backend: ConversationListItem[]
): ConversationListItem[] {
  const byId = new Map<string, ConversationListItem>()
  
  // Add local first
  for (const item of local) {
    byId.set(item.id, item)
  }
  
  // Backend overwrites local (has more metadata)
  for (const item of backend) {
    const existing = byId.get(item.id)
    if (existing) {
      // Merge, preferring backend metadata
      byId.set(item.id, {
        ...existing,
        ...item,
        source: "mixed", // Exists in both
        messageCount: Math.max(existing.messageCount, item.messageCount),
      })
    } else {
      byId.set(item.id, item)
    }
  }
  
  // Sort by updatedAt descending
  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Remove duplicate conversations from list.
 */
function dedupeConversationList(
  items: ConversationListItem[]
): ConversationListItem[] {
  const seen = new Map<string, ConversationListItem>()
  
  for (const item of items) {
    const existing = seen.get(item.id)
    if (!existing || item.updatedAt > existing.updatedAt) {
      seen.set(item.id, item)
    }
  }
  
  return Array.from(seen.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

// =============================================================================
// Selectors
// =============================================================================

export const selectConversations = (state: ConversationStoreState) => state.conversations
export const selectIsListLoading = (state: ConversationStoreState) => 
  state.listLoadingState === "loading" || state.listLoadingState === "refreshing"
export const selectHasMore = (state: ConversationStoreState) => state.hasMore
export const selectIsLoadingConversation = (state: ConversationStoreState) => 
  state.conversationLoadingState === "loading"
export const selectLastRecapSessionId = (state: ConversationStoreState) => 
  state.lastRecapSessionId
