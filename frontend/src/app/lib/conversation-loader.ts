/**
 * Conversation Loader Service
 * ===========================
 * 
 * Phase 4 Week 4 - Subphase 3: Conversation History Consistency
 * 
 * Idempotent conversation loading that:
 * 1. Sets app state to "loading"
 * 2. Fetches messages from backend (or local cache)
 * 3. REPLACES chat-store messages atomically (not append)
 * 4. Cancels any in-flight streams before loading
 * 5. Cleans up streaming state
 */

import { useChatStore } from "../stores/chat-store"
import { useSessionStore } from "../stores/session-store"
import { useSessionHistoryStore } from "../stores/session-history-store"
import { loadConversationFromHistory } from "./conversation-history"
import { dedupeMessages, normalizeMessages } from "./message-dedupe"
import { logger } from "./error-logger"
import type { ChatMessage } from "../types"
import type { 
  ConversationId, 
  BackendMessage,
  BackendConversationListItem,
  ConversationCursor,
} from "../types/conversation-identity"

// =============================================================================
// Types
// =============================================================================

export type LoadingState = "idle" | "loading" | "success" | "error"

export interface LoadConversationResult {
  success: boolean
  conversationId?: ConversationId
  messageCount?: number
  error?: string
  source: "local" | "backend" | "cache"
}

export interface ConversationLoaderOptions {
  /** Force refresh from backend even if cached */
  forceRefresh?: boolean
  /** Limit number of messages to load */
  messageLimit?: number
  /** Cursor for pagination */
  cursor?: ConversationCursor
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MESSAGE_LIMIT = 30

// =============================================================================
// Backend API Calls
// =============================================================================

/**
 * Fetch conversation messages from backend.
 * GET /api/v1/conversations/sessions/{session_id}/messages?limit=30&before=...
 */
async function fetchBackendMessages(
  conversationId: ConversationId,
  options: ConversationLoaderOptions = {}
): Promise<BackendMessage[]> {
  const limit = options.messageLimit ?? DEFAULT_MESSAGE_LIMIT
  const params = new URLSearchParams({ limit: String(limit) })
  
  if (options.cursor?.before) {
    params.set('before', options.cursor.before)
  }

  // Use local proxy — auth handled server-side (httpOnly cookie)
  const url = `/api/conversation/${conversationId}/messages?${params}`
  
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    if (response.status === 404) {
      // Session not found - might be local-only
      return []
    }
    throw new Error(`Failed to fetch messages: ${response.status}`)
  }

  const data = await response.json()
  
  // Handle different response formats
  if (Array.isArray(data)) {
    return data
  }
  if (data.messages && Array.isArray(data.messages)) {
    return data.messages
  }
  
  return []
}

/**
 * Fetch conversation list from backend.
 * GET /api/v1/conversations/sessions?page=1&page_size=20
 */
export async function fetchBackendConversations(
  options: { limit?: number; cursor?: string } = {}
): Promise<BackendConversationListItem[]> {
  const pageSize = options.limit ?? 20
  const rawPage = options.cursor ? Number(options.cursor) : 1
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1

  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  })

  // Use local proxy — auth handled server-side (httpOnly cookie)
  const url = `/api/conversation/sessions?${params}`
  
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      if (response.status === 404 || response.status === 501) {
        // Endpoint not implemented yet
        return []
      }
      throw new Error(`Failed to fetch conversations: ${response.status}`)
    }

    const data = await response.json()
    
    // Handle different response formats
    if (Array.isArray(data)) {
      return data.map(normalizeConversationItem)
    }
    if (data.sessions && Array.isArray(data.sessions)) {
      return data.sessions.map(normalizeConversationItem)
    }
    if (data.conversations && Array.isArray(data.conversations)) {
      return data.conversations.map(normalizeConversationItem)
    }
    
    return []
  } catch (error) {
    logger.debug("ConversationLoader", "Failed to fetch backend conversations", { error })
    return []
  }
}

/**
 * Normalize backend conversation item to consistent format.
 */
function normalizeConversationItem(item: Record<string, unknown>): BackendConversationListItem {
  return {
    conversation_id: (item.conversation_id || item.session_id || item.id) as string,
    session_id: (item.session_id || item.id) as string,
    thread_id: item.thread_id as string | undefined,
    title: item.title as string | undefined,
    preview: (item.preview || item.last_message_preview) as string | undefined,
    updated_at: (item.updated_at || item.ended_at || item.created_at) as string,
    created_at: (item.created_at || item.started_at) as string,
    last_message_preview: item.last_message_preview as string | undefined,
    turn_count: (item.turn_count || item.message_count || 0) as number,
    has_recap: item.has_recap as boolean | undefined,
    is_active: (item.is_active || item.status === 'active') as boolean | undefined,
    meta: item.meta as Record<string, unknown> | undefined,
  }
}

/**
 * Convert backend message to ChatMessage format.
 */
function backendMessageToChatMessage(msg: BackendMessage): ChatMessage {
  return {
    id: msg.message_id,
    role: msg.role,
    content: msg.content,
    createdAt: new Date(msg.created_at).getTime(),
    status: "complete",
    audioUrl: msg.audio_url ?? undefined,
    turnId: msg.turn_id,
    source: msg.meta?.source as "voice" | "text" | undefined,
    meta: msg.meta,
  }
}

// =============================================================================
// Main Loader Functions
// =============================================================================

/**
 * Load a conversation by ID - IDEMPOTENT and ATOMIC.
 * 
 * This is the CANONICAL way to load a conversation. It:
 * 1. Cancels any in-flight streams
 * 2. Clears streaming state
 * 3. Fetches messages (backend or local)
 * 4. REPLACES (not appends) messages in chat-store
 * 5. Sets all identity fields correctly
 */
export async function loadConversation(
  conversationId: ConversationId,
  source: "local" | "backend" = "local",
  options: ConversationLoaderOptions = {}
): Promise<LoadConversationResult> {
  const chatStore = useChatStore.getState()
  
  // Step 1: Cancel any in-flight streams
  if (chatStore.abortController) {
    logger.debug("ConversationLoader", "Cancelling in-flight stream before loading", { conversationId })
    chatStore.abortController.abort()
  }

  // Step 2: Set loading state atomically
  useChatStore.setState({
    isLoadingHistory: true,
    // Clear streaming state
    abortController: undefined,
    activeReplyId: undefined,
    streamStatus: "idle",
    streamAttempt: 0,
    isLocked: false,
  })

  try {
    let messages: ChatMessage[] = []
    let actualSource: "local" | "backend" | "cache" = source

    // Step 3: Fetch messages
    if (source === "backend") {
      try {
        const backendMessages = await fetchBackendMessages(conversationId, options)
        if (backendMessages.length > 0) {
          messages = backendMessages.map(backendMessageToChatMessage)
          actualSource = "backend"
        } else {
          // Fall back to local if backend returns empty
          const local = loadConversationFromHistory(conversationId)
          if (local) {
            messages = local.messages
            actualSource = "local"
          }
        }
      } catch (error) {
        logger.debug("ConversationLoader", "Backend fetch failed, falling back to local", { error })
        const local = loadConversationFromHistory(conversationId)
        if (local) {
          messages = local.messages
          actualSource = "local"
        }
      }
    } else {
      // Load from local storage
      const local = loadConversationFromHistory(conversationId)
      if (local) {
        messages = local.messages
        actualSource = "local"
      }
    }

    if (messages.length === 0) {
      useChatStore.setState({
        isLoadingHistory: false,
        lastError: "Conversation not found",
      })
      return {
        success: false,
        error: "Conversation not found",
        source: actualSource,
      }
    }

    // Step 4: Dedupe messages to prevent duplicates
    const dedupedMessages = dedupeMessages(messages)
    const normalizedMessages = normalizeMessages(dedupedMessages)

    // Step 5: ATOMIC REPLACE - This is the key to preventing duplicates
    const lastMessage = normalizedMessages[normalizedMessages.length - 1]
    const lastUserMessage = [...normalizedMessages].reverse().find(m => m.role === "user")
    
    useChatStore.setState({
      // REPLACE messages entirely
      messages: normalizedMessages,
      conversationId,
      // Set identity tracking
      lastCompletedTurnId: lastMessage?.turnId ?? lastMessage?.id,
      lastUserTurnId: lastUserMessage?.id,
      // Clear all streaming/error state
      activeReplyId: undefined,
      abortController: undefined,
      streamStatus: "idle",
      streamAttempt: 0,
      isLocked: false,
      isLoadingHistory: false,
      lastError: undefined,
      feedbackGate: undefined,
    })
    
    // Step 6: Also update session-store so session page can read the messages
    // Convert ChatMessage format to session-store format
    const sessionMessages = normalizedMessages.map(m => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      createdAt: typeof m.createdAt === 'number' 
        ? new Date(m.createdAt).toISOString() 
        : m.createdAt || new Date().toISOString(),
    }))
    
    useSessionStore.getState().updateMessages(sessionMessages)
    
    // Also set the sessionId in session store if we have one
    const sessionStore = useSessionStore.getState()
    const historyEntry = useSessionHistoryStore.getState().getSession(conversationId)

    const inferredStart = sessionMessages[0]?.createdAt || new Date().toISOString()
    const inferredEnd = sessionMessages[sessionMessages.length - 1]?.createdAt || inferredStart
    const startedAt = historyEntry?.startedAt || sessionStore.session?.startedAt || inferredStart
    const endedAt = historyEntry?.endedAt || sessionStore.session?.endedAt || inferredEnd

    const startedMs = Date.parse(startedAt)
    const endedMs = Date.parse(endedAt)
    const hasValidRange = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs
    const elapsedSecondsFromRange = hasValidRange
      ? Math.floor((endedMs - startedMs) / 1000)
      : sessionStore.session?.activeElapsedSeconds
    if (!sessionStore.session || sessionStore.session.sessionId !== conversationId) {
      // Create a minimal session for history viewing
      useSessionStore.setState({
        session: {
          ...sessionStore.session,
          sessionId: conversationId,
          messages: sessionMessages,
          userId: sessionStore.session?.userId || 'history',
          presetType: historyEntry?.presetType || sessionStore.session?.presetType || 'open',
          contextMode: historyEntry?.contextMode || sessionStore.session?.contextMode || 'life',
          startedAt,
          endedAt,
          status: 'ended',
          activeElapsedSeconds: elapsedSecondsFromRange,
          activeSegmentStartedAt: undefined,
          lastActivityAt: endedAt,
          isActive: false, // Loaded from history
        }
      })
    }

    logger.debug("ConversationLoader", "Conversation loaded successfully", {
      conversationId,
      messageCount: normalizedMessages.length,
      source: actualSource,
    })

    return {
      success: true,
      conversationId,
      messageCount: normalizedMessages.length,
      source: actualSource,
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to load conversation"
    
    useChatStore.setState({
      isLoadingHistory: false,
      lastError: errorMessage,
    })

    logger.logError(error, {
      component: "ConversationLoader",
      action: "loadConversation",
      conversationId,
    })

    return {
      success: false,
      error: errorMessage,
      source,
    }
  }
}

/**
 * Load more messages (pagination) - PREPENDS to existing messages.
 * Uses cursor-based pagination with deduplication.
 */
export async function loadMoreMessages(
  conversationId: ConversationId,
  cursor: ConversationCursor
): Promise<{ success: boolean; newCount: number }> {
  const chatStore = useChatStore.getState()
  
  // Don't load more while streaming
  if (chatStore.streamStatus === "streaming") {
    return { success: false, newCount: 0 }
  }

  try {
    const backendMessages = await fetchBackendMessages(conversationId, { cursor })
    
    if (backendMessages.length === 0) {
      return { success: true, newCount: 0 }
    }

    const newMessages = backendMessages.map(backendMessageToChatMessage)
    
    // Combine with existing and dedupe
    const existingMessages = chatStore.messages
    const combined = [...newMessages, ...existingMessages]
    const deduped = dedupeMessages(combined)
    const normalized = normalizeMessages(deduped)
    
    // Sort by createdAt to maintain order
    normalized.sort((a, b) => a.createdAt - b.createdAt)

    useChatStore.setState({
      messages: normalized,
    })

    return {
      success: true,
      newCount: normalized.length - existingMessages.length,
    }

  } catch (error) {
    logger.logError(error, {
      component: "ConversationLoader",
      action: "loadMoreMessages",
      conversationId,
    })
    return { success: false, newCount: 0 }
  }
}

/**
 * Start a new conversation - clears state cleanly.
 */
export function startNewConversation(): void {
  const chatStore = useChatStore.getState()
  
  // Cancel any in-flight streams
  if (chatStore.abortController) {
    chatStore.abortController.abort()
  }

  // Atomic clear
  useChatStore.setState({
    messages: [],
    conversationId: undefined,
    activeReplyId: undefined,
    abortController: undefined,
    streamStatus: "idle",
    streamAttempt: 0,
    isLocked: false,
    isLoadingHistory: false,
    lastError: undefined,
    feedbackGate: undefined,
    lastCompletedTurnId: undefined,
    lastUserTurnId: undefined,
  })

  // Also clear session store if needed
  useSessionStore.getState().clearSession()
}

/**
 * Check if we should cancel current stream when switching conversations.
 */
export function shouldCancelStreamOnSwitch(): boolean {
  const { streamStatus, isLocked, abortController } = useChatStore.getState()
  return (
    streamStatus === "streaming" || 
    streamStatus === "reconnecting" || 
    isLocked || 
    !!abortController
  )
}

/**
 * Cancel current stream if active (for conversation switching).
 */
export function cancelCurrentStream(): boolean {
  const { abortController, conversationId, activeReplyId } = useChatStore.getState()
  
  if (!abortController) {
    return false
  }

  // Abort the fetch
  abortController.abort()

  // Notify backend (fire-and-forget)
  if (conversationId) {
    fetch(`/api/conversation/${conversationId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).catch(() => {
      // Ignore errors - best effort
    })
  }

  // Clean up state but DON'T remove the message - mark it as cancelled
  useChatStore.setState((state) => ({
    messages: state.messages.map((m) =>
      m.id === activeReplyId
        ? { ...m, status: "cancelled", content: m.content || "" }
        : m
    ),
    isLocked: false,
    activeReplyId: undefined,
    abortController: undefined,
    streamStatus: "cancelled",
    streamAttempt: 0,
  }))

  return true
}
