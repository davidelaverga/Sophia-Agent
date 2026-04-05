"use client"

import type { 
  ChatMessage, 
  ConversationSummary, 
  ArchivedConversation, 
  ConversationHistory,
} from "../types"
import type { FocusMode } from "../stores/ui-store"
import { formatRelativeTime as formatTime } from "./format-time"
import { isVerboseDebugEnabled } from "./debug"
import { debugLog, debugWarn } from "./debug-logger"

// Re-export types for backwards compatibility
export type { ConversationSummary, ArchivedConversation, ConversationHistory }

const HISTORY_KEY = "sophia-conversation-history"
const CURRENT_SESSION_KEY = "sophia-session"
const MAX_HISTORY_ITEMS = 10
const MAX_AGE_DAYS = 30

const verboseLog = (...args: unknown[]) => {
  if (isVerboseDebugEnabled()) {
    const [message, data] = args
    debugLog("ConversationHistory", String(message), data)
  }
}

/**
 * Generate a title from the first user message
 */
function generateTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find(m => m.role === "user")
  if (!firstUserMessage) return "New Conversation"
  
  const text = firstUserMessage.content.trim()
  if (text.length <= 40) return text
  
  // Truncate at word boundary
  const truncated = text.slice(0, 40)
  const lastSpace = truncated.lastIndexOf(" ")
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "..."
}

/**
 * Generate a preview from the last sophia message
 */
function generatePreview(messages: ChatMessage[]): string {
  const lastSophiaMessage = [...messages].reverse().find(m => m.role === "sophia")
  if (!lastSophiaMessage) return "Start of conversation"
  
  const text = lastSophiaMessage.content.trim()
  if (text.length <= 60) return text
  
  const truncated = text.slice(0, 60)
  const lastSpace = truncated.lastIndexOf(" ")
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "..."
}

/**
 * Load conversation history from localStorage
 */
export function loadConversationHistory(): ConversationHistory {
  if (typeof window === "undefined") {
    return { conversations: [], lastUpdated: Date.now() }
  }
  
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return { conversations: [], lastUpdated: Date.now() }
    
    const history = JSON.parse(raw) as ConversationHistory
    
    // Filter out old conversations
    const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - maxAge
    history.conversations = history.conversations.filter(c => c.updatedAt > cutoff)
    
    return history
  } catch (error) {
    debugWarn("ConversationHistory", "Failed to load", { error })
    return { conversations: [], lastUpdated: Date.now() }
  }
}

/**
 * Save conversation to history
 */
export function archiveConversation(
  conversationId: string,
  messages: ChatMessage[],
  focusMode?: FocusMode
): void {
  if (typeof window === "undefined") return
  if (messages.length < 2) {
    verboseLog("[ConversationHistory] Skipping archive - not enough messages", { conversationId, messageCount: messages.length })
    return
  }
  
  verboseLog("[ConversationHistory] Archiving conversation", { 
    conversationId, 
    messageCount: messages.length,
    firstMsgRole: messages[0]?.role,
    lastMsgRole: messages[messages.length - 1]?.role,
  })
  
  try {
    const history = loadConversationHistory()
    
    // Check if conversation already exists
    const existingIndex = history.conversations.findIndex(c => c.id === conversationId)
    
    verboseLog("[ConversationHistory] Archive state", { 
      existingIndex, 
      totalConversations: history.conversations.length,
      existingIds: history.conversations.map(c => c.id.slice(0, 8) + '...'),
    })
    
    const archivedConversation: ArchivedConversation = {
      id: conversationId,
      messages,
      focusMode,
      createdAt: existingIndex >= 0 
        ? history.conversations[existingIndex].createdAt 
        : messages[0]?.createdAt || Date.now(),
      updatedAt: Date.now(),
    }
    
    if (existingIndex >= 0) {
      // Update existing
      verboseLog("[ConversationHistory] Updating existing conversation at index", existingIndex)
      history.conversations[existingIndex] = archivedConversation
    } else {
      // Add new at the beginning
      verboseLog("[ConversationHistory] Adding new conversation")
      history.conversations.unshift(archivedConversation)
    }
    
    // Limit history size
    if (history.conversations.length > MAX_HISTORY_ITEMS) {
      history.conversations = history.conversations.slice(0, MAX_HISTORY_ITEMS)
    }
    
    history.lastUpdated = Date.now()
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
    verboseLog("[ConversationHistory] Saved to localStorage", { 
      totalConversations: history.conversations.length 
    })
  } catch (error) {
    debugWarn("ConversationHistory", "Failed to archive", { error })
  }
}

/**
 * Analyze messages to determine predominant input mode
 */
function analyzeInputMode(messages: ChatMessage[]): { 
  inputMode: "voice" | "text" | "mixed"
  voiceCount: number
  textCount: number 
} {
  const voiceCount = messages.filter(m => m.source === "voice").length
  const textCount = messages.filter(m => m.source === "text" || !m.source).length
  
  // Determine predominant mode
  let inputMode: "voice" | "text" | "mixed"
  if (voiceCount === 0) {
    inputMode = "text"
  } else if (textCount === 0) {
    inputMode = "voice"
  } else if (voiceCount > textCount * 2) {
    inputMode = "voice" // Mostly voice
  } else if (textCount > voiceCount * 2) {
    inputMode = "text" // Mostly text
  } else {
    inputMode = "mixed"
  }
  
  return { inputMode, voiceCount, textCount }
}

/**
 * Get conversation summaries for display
 */
export function getConversationSummaries(): ConversationSummary[] {
  const history = loadConversationHistory()
  
  return history.conversations.map(conv => {
    const { inputMode, voiceCount, textCount } = analyzeInputMode(conv.messages)
    
    return {
      id: conv.id,
      title: generateTitle(conv.messages),
      preview: generatePreview(conv.messages),
      messageCount: conv.messages.length,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      focusMode: conv.focusMode,
      inputMode,
      voiceCount,
      textCount,
    }
  })
}

/**
 * Load a specific conversation from history
 */
export function loadConversationFromHistory(conversationId: string): ArchivedConversation | null {
  const history = loadConversationHistory()
  return history.conversations.find(c => c.id === conversationId) || null
}

/**
 * Delete a conversation from history
 */
export function deleteConversationFromHistory(conversationId: string): void {
  if (typeof window === "undefined") return
  
  try {
    const history = loadConversationHistory()
    history.conversations = history.conversations.filter(c => c.id !== conversationId)
    history.lastUpdated = Date.now()
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch (error) {
    debugWarn("ConversationHistory", "Failed to delete", { error })
  }
}

/**
 * Clear all conversation history
 */
export function clearAllHistory(): void {
  if (typeof window === "undefined") return
  
  try {
    localStorage.removeItem(HISTORY_KEY)
    localStorage.removeItem(CURRENT_SESSION_KEY)
  } catch (error) {
    debugWarn("ConversationHistory", "Failed to clear", { error })
  }
}

/**
 * Check if there's a restorable session
 */
export function hasRestorableSession(): boolean {
  if (typeof window === "undefined") return false
  
  try {
    const raw = localStorage.getItem(CURRENT_SESSION_KEY)
    if (!raw) return false
    
    const session = JSON.parse(raw)
    const age = Date.now() - session.timestamp
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours
    
    return age < maxAge && session.messages?.length > 0
  } catch {
    return false
  }
}

/**
 * Get the current session preview
 */
export function getCurrentSessionPreview(): ConversationSummary | null {
  if (typeof window === "undefined") return null
  
  try {
    const raw = localStorage.getItem(CURRENT_SESSION_KEY)
    if (!raw) return null
    
    const session = JSON.parse(raw)
    if (!session.messages?.length) return null
    
    // Calculate voice/text counts
    const voiceMessages = session.messages.filter((m: ChatMessage) => m.source === "voice")
    const textMessages = session.messages.filter((m: ChatMessage) => m.source === "text" || !m.source)
    const voiceCount = voiceMessages.length
    const textCount = textMessages.length
    
    // Determine input mode
    let inputMode: "voice" | "text" | "mixed" = "text"
    if (voiceCount > 0 && textCount > 0) {
      inputMode = "mixed"
    } else if (voiceCount > textCount) {
      inputMode = "voice"
    }
    
    return {
      id: session.conversationId,
      title: generateTitle(session.messages),
      preview: generatePreview(session.messages),
      messageCount: session.messages.length,
      createdAt: session.messages[0]?.createdAt || session.timestamp,
      updatedAt: session.timestamp,
      focusMode: session.focusMode,
      inputMode,
      voiceCount,
      textCount,
    }
  } catch {
    return null
  }
}

/**
 * Format relative time with humanized language
 * Re-exported from format-time for backwards compatibility
 */
export function formatRelativeTime(timestamp: number): string {
  return formatTime(timestamp)
}
