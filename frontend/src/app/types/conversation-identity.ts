/**
 * Conversation Identity Types
 * ===========================
 * 
 * Phase 4 Week 4 - Subphase 3: Conversation History Consistency
 * 
 * This file defines the canonical identity model for conversations.
 * All IDs should follow this schema to prevent duplication and confusion.
 * 
 * Identity Hierarchy:
 * - conversationId: UI-level conversation container (what History lists and uses)
 * - sessionId: Backend session entity (maps to conversationId, often the same)
 * - threadId: Backend LangGraph thread identity (for resume/memory/interrupts)
 * - turnId: Unique ID per user→assistant exchange
 * - messageId: Unique ID for each individual message
 */

// =============================================================================
// Identity Types
// =============================================================================

/** 
 * Unique identifier for a conversation in the UI.
 * This is the PRIMARY KEY used by History and chat-store.
 * Format: "conv_<timestamp>_<random>" or backend-provided session_id
 */
export type ConversationId = string

/**
 * Backend session identifier.
 * Usually equals conversationId when synced with backend.
 */
export type SessionId = string

/**
 * LangGraph thread identifier.
 * Required for resume, memory, and interrupt functionality.
 */
export type ThreadId = string

/**
 * Unique identifier for a turn (user + assistant exchange).
 * Format: "turn_<timestamp>_<random>"
 */
export type TurnId = string

/**
 * Unique identifier for a single message.
 * Format: "msg_<timestamp>_<random>"
 */
export type MessageId = string

// =============================================================================
// Identity Mapping
// =============================================================================

/**
 * Maps all identity layers for a conversation.
 * This is the source of truth for ID relationships.
 */
export interface ConversationIdentity {
  /** UI-level conversation ID (primary key) */
  conversationId: ConversationId
  /** Backend session ID (may equal conversationId) */
  sessionId?: SessionId
  /** LangGraph thread ID for stateful operations */
  threadId?: ThreadId
  /** ID of the last completed turn */
  lastTurnId?: TurnId
  /** ID of the last completed message */
  lastMessageId?: MessageId
  /** When identities were last synced with backend */
  syncedAt?: number
}

// =============================================================================
// Backend Contracts (What we expect from API)
// =============================================================================

/**
 * Conversation list item from backend.
 * GET /conversations?limit=20&cursor=...
 */
export interface BackendConversationListItem {
  conversation_id: string
  session_id?: string
  thread_id?: string
  title?: string
  preview?: string
  updated_at: string
  created_at: string
  last_message_preview?: string
  turn_count: number
  has_recap?: boolean
  is_active?: boolean
  meta?: Record<string, unknown>
}

/**
 * Message from backend with full identity.
 * GET /conversations/{id}/messages?limit=30&before=...
 */
export interface BackendMessage {
  message_id: string
  turn_id?: string
  role: "user" | "sophia" | "system"
  content: string
  created_at: string
  audio_url?: string | null
  meta?: {
    session_type?: string
    preset?: string
    artifacts_status?: string
    source?: "voice" | "text"
    [key: string]: unknown
  }
}

/**
 * Session status from backend.
 * GET /sessions/{id}/status
 */
export interface BackendSessionStatus {
  session_id: string
  thread_id?: string
  status: "active" | "ended" | "expired"
  pending_interrupt?: boolean
  interrupt_type?: string
  last_activity_at?: string
}

/**
 * Pagination cursor for conversation list.
 */
export interface ConversationCursor {
  before?: string // Message ID or timestamp
  after?: string
  limit: number
}

// =============================================================================
// Message with Identity
// =============================================================================

/**
 * Extended ChatMessage with full identity tracking.
 */
export interface IdentifiedMessage {
  /** Unique message ID */
  messageId: MessageId
  /** Turn this message belongs to */
  turnId?: TurnId
  /** Role in conversation */
  role: "user" | "sophia" | "system"
  /** Message content */
  content: string
  /** Creation timestamp */
  createdAt: number
  /** Message status */
  status?: "streaming" | "complete" | "error" | "cancelled" | "interrupted"
  /** Audio URL if voice message */
  audioUrl?: string
  /** Input source */
  source?: "voice" | "text"
  /** Content hash for deduplication */
  contentHash?: string
  /** Additional metadata */
  meta?: Record<string, unknown>
}

// =============================================================================
// ID Generation Utilities
// =============================================================================

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomString(length: number): string {
  let result = ''
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  for (let i = 0; i < length; i++) {
    result += CHARSET[array[i] % CHARSET.length]
  }
  return result
}

/** Generate a new conversation ID */
export function generateConversationId(): ConversationId {
  return `conv_${Date.now()}_${randomString(6)}`
}

/** Generate a new turn ID */
export function generateTurnId(): TurnId {
  return `turn_${Date.now()}_${randomString(6)}`
}

/** Generate a new message ID */
export function generateMessageId(): MessageId {
  return `msg_${Date.now()}_${randomString(6)}`
}

// =============================================================================
// Fingerprint for Deduplication
// =============================================================================

/**
 * Generate a content hash for deduplication.
 * Used when message_id is not available.
 */
export function generateContentHash(content: string): string {
  // Simple hash function for content fingerprinting
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return `h_${Math.abs(hash).toString(36)}`
}

/**
 * Generate a composite fingerprint for a message.
 * Format: role_timestamp_contentHash
 * Used when message_id is not provided by backend.
 */
export function generateMessageFingerprint(
  role: string,
  createdAt: number | string,
  content: string
): string {
  const timestamp = typeof createdAt === 'string' 
    ? new Date(createdAt).getTime() 
    : createdAt
  const contentHash = generateContentHash(content)
  return `${role}_${timestamp}_${contentHash}`
}

// =============================================================================
// Type Guards
// =============================================================================

export function isConversationId(id: string): id is ConversationId {
  return id.startsWith('conv_') || id.startsWith('sess_') || id.length > 10
}

export function isTurnId(id: string): id is TurnId {
  return id.startsWith('turn_')
}

export function isMessageId(id: string): id is MessageId {
  return id.startsWith('msg_')
}
