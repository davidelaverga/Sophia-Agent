/**
 * Conversation Types
 * ==================
 * 
 * Unified type definitions for messages, conversations, and sessions.
 * All stores and components should import from here for consistency.
 */

import type { FocusMode } from "../stores/ui-store"

// =============================================================================
// Base Types
// =============================================================================

/** Role in a conversation */
export type MessageRole = "user" | "sophia" | "system"

/** Status of a streaming message */
export type MessageStatus = "streaming" | "complete" | "error" | "cancelled" | "interrupted"

/** How the message was created */
export type MessageSource = "voice" | "text"

/** Input mode based on predominant message sources */
export type InputMode = "voice" | "text" | "mixed"

// =============================================================================
// Emotion
// =============================================================================

export interface EmotionData {
  label?: string
  confidence?: number
  scores?: Record<string, number>
}

// =============================================================================
// Messages
// =============================================================================

/**
 * Chat message as stored in the client-side store
 */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: number
  status?: MessageStatus
  audioUrl?: string
  turnId?: string
  source?: MessageSource
  /** Additional metadata for recovery, debugging, etc */
  meta?: Record<string, unknown>
}

/**
 * Message from the backend API (sessions endpoint)
 * Uses snake_case to match API response format
 */
export interface ApiMessage {
  id: string
  session_id: string
  role: "user" | "sophia"
  content: string
  audio_url?: string | null
  emotion?: EmotionData | null
  created_at: string | null
}

// =============================================================================
// Sessions
// =============================================================================

/**
 * Session summary from backend (list endpoint)
 */
export interface SessionSummary {
  id: string
  started_at: string
  ended_at: string | null
  turn_count: number
  meta?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/**
 * Full session with messages from backend
 */
export interface SessionWithMessages extends SessionSummary {
  messages: ApiMessage[]
}

// =============================================================================
// Conversation History (Local Storage)
// =============================================================================

/**
 * Summary of a conversation for display in history list
 */
export interface ConversationSummary {
  id: string
  title: string
  preview: string
  messageCount: number
  createdAt: number
  updatedAt: number
  focusMode?: FocusMode
  inputMode: InputMode
  voiceCount: number
  textCount: number
  /** Whether synced to backend */
  synced?: boolean
  /** Backend session ID if synced */
  backendId?: string
}

/**
 * Archived conversation with full message history
 */
export interface ArchivedConversation {
  id: string
  messages: ChatMessage[]
  focusMode?: FocusMode
  createdAt: number
  updatedAt: number
}

/**
 * Local storage structure for conversation history
 */
export interface ConversationHistory {
  conversations: ArchivedConversation[]
  lastUpdated: number
}

// =============================================================================
// Converters
// =============================================================================

/**
 * Convert API message to ChatMessage format
 */
export function apiMessageToChatMessage(msg: ApiMessage): ChatMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    createdAt: msg.created_at ? new Date(msg.created_at).getTime() : Date.now(),
    status: "complete",
    audioUrl: msg.audio_url ?? undefined,
    source: msg.audio_url ? "voice" : "text",
  }
}

/**
 * Convert ChatMessage to API message format
 */
export function chatMessageToApiMessage(msg: ChatMessage, sessionId: string): ApiMessage {
  return {
    id: msg.id,
    session_id: sessionId,
    role: msg.role === "system" ? "sophia" : msg.role,
    content: msg.content,
    audio_url: msg.audioUrl ?? null,
    emotion: null,
    created_at: new Date(msg.createdAt).toISOString(),
  }
}

/**
 * Determine input mode from message counts
 */
export function determineInputMode(voiceCount: number, textCount: number): InputMode {
  if (voiceCount > 0 && textCount > 0) return "mixed"
  if (voiceCount > 0) return "voice"
  return "text"
}
