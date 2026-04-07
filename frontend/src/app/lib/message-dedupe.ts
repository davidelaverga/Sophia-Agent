/**
 * Message Deduplication Utilities
 * ================================
 * 
 * Phase 4 Week 4 - Subphase 3: Conversation History Consistency
 * 
 * The heart of preventing "Sophia repeats" and "scrambled chat".
 * 
 * Dedupe Strategy:
 * 1. Prefer message_id if available (unique key)
 * 2. Fall back to composite fingerprint: role + created_at + content_hash
 * 3. For streaming messages, use activeReplyId as temporary key
 */

import type { ChatMessage } from "../types"
import { 
  generateContentHash, 
  generateMessageFingerprint,
  generateMessageId,
} from "../types/conversation-identity"

// =============================================================================
// Dedupe Key Generation
// =============================================================================

/**
 * Get or generate a unique dedupe key for a message.
 * Priority:
 * 1. message_id (from backend or generated)
 * 2. turnId + role (for turns)
 * 3. composite fingerprint (role + timestamp + content_hash)
 */
export function getDedupeKey(message: ChatMessage): string {
  // If we have a proper ID, use it
  if (message.id && !message.id.startsWith('temp_')) {
    return message.id
  }

  // For streaming messages with a turnId, use turnId + role
  if (message.turnId && message.status === "streaming") {
    return `streaming_${message.turnId}_${message.role}`
  }

  // Fall back to fingerprint
  return generateMessageFingerprint(
    message.role,
    message.createdAt,
    message.content
  )
}

/**
 * Check if two messages are duplicates.
 */
export function areDuplicates(a: ChatMessage, b: ChatMessage): boolean {
  // Same ID = definitely duplicate
  if (a.id === b.id) return true

  // Same turnId and role = same message in different states
  if (a.turnId && a.turnId === b.turnId && a.role === b.role) {
    return true
  }

  // If same role and very close timestamps with same content hash
  if (a.role === b.role) {
    const timeDiff = Math.abs(a.createdAt - b.createdAt)
    if (timeDiff < 1000) { // Within 1 second
      const hashA = generateContentHash(a.content)
      const hashB = generateContentHash(b.content)
      if (hashA === hashB) return true
    }
  }

  return false
}

// =============================================================================
// Dedupe Functions
// =============================================================================

/**
 * Remove duplicate messages from a list.
 * Keeps the most complete version (longest content, best status).
 */
export function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Map<string, ChatMessage>()

  for (const message of messages) {
    const key = getDedupeKey(message)
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, message)
      continue
    }

    // Keep the better version
    const better = pickBetterMessage(existing, message)
    seen.set(key, better)
  }

  // Return in original order (by createdAt)
  return Array.from(seen.values()).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Pick the "better" of two messages (more complete version).
 */
function pickBetterMessage(a: ChatMessage, b: ChatMessage): ChatMessage {
  // Prefer complete over streaming/error
  const statusPriority: Record<string, number> = {
    complete: 4,
    streaming: 3,
    error: 2,
    cancelled: 1,
    interrupted: 1,
  }

  const priorityA = statusPriority[a.status ?? 'complete'] ?? 0
  const priorityB = statusPriority[b.status ?? 'complete'] ?? 0

  if (priorityA !== priorityB) {
    return priorityA > priorityB ? a : b
  }

  // Prefer longer content (more complete)
  if (a.content.length !== b.content.length) {
    return a.content.length > b.content.length ? a : b
  }

  // Prefer newer (more recently updated)
  return a.createdAt > b.createdAt ? a : b
}

// =============================================================================
// Normalize Messages
// =============================================================================

/**
 * Normalize messages to ensure consistent format.
 * - Ensures all messages have IDs
 * - Ensures all have createdAt timestamps
 * - Removes empty messages
 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter(m => m.content || m.status === "streaming")
    .map(m => ({
      ...m,
      id: m.id || generateMessageId(),
      createdAt: m.createdAt || Date.now(),
      status: m.status ?? "complete",
    }))
}

/**
 * Merge streaming update into existing messages.
 * This handles the case where we receive a "done" event.
 * 
 * Rules:
 * 1. If activeReplyId exists, update that message
 * 2. If matching turnId exists, update that message
 * 3. Otherwise, add as new message (shouldn't happen in normal flow)
 */
export function mergeStreamingUpdate(
  messages: ChatMessage[],
  update: Partial<ChatMessage> & { id: string },
  activeReplyId?: string
): ChatMessage[] {
  const targetId = activeReplyId || update.id
  const existingIndex = messages.findIndex(m => m.id === targetId)

  if (existingIndex >= 0) {
    // Update existing message
    return messages.map((m, i) =>
      i === existingIndex
        ? { ...m, ...update, id: m.id } // Keep original ID
        : m
    )
  }

  // Check by turnId
  if (update.turnId) {
    const turnIndex = messages.findIndex(
      m => m.turnId === update.turnId && m.role === update.role
    )
    if (turnIndex >= 0) {
      return messages.map((m, i) =>
        i === turnIndex
          ? { ...m, ...update, id: m.id }
          : m
      )
    }
  }

  // Add as new (shouldn't normally happen)
  return [...messages, update as ChatMessage]
}

// =============================================================================
// Stream Completion Handling
// =============================================================================

/**
 * Handle stream completion - ensures no duplicates on "done" event.
 * 
 * This is called when we receive the final message from the stream.
 * It should either:
 * 1. Update the existing placeholder (activeReplyId), OR
 * 2. Replace last assistant bubble if it matches the same turn
 */
export function handleStreamCompletion(
  messages: ChatMessage[],
  finalContent: string,
  activeReplyId: string,
  payload?: {
    turnId?: string
    audioUrl?: string
    messageId?: string
  }
): ChatMessage[] {
  // Find the streaming placeholder
  const placeholderIndex = messages.findIndex(m => m.id === activeReplyId)
  
  if (placeholderIndex < 0) {
    // No placeholder found - this shouldn't happen in normal flow
    // Check if there's already a complete message with this turnId
    if (payload?.turnId) {
      const existingTurn = messages.find(
        m => m.turnId === payload.turnId && m.role === "sophia" && m.status === "complete"
      )
      if (existingTurn) {
        // Already have a complete version - skip
        return messages
      }
    }
    
    // Add as new message (fallback)
    return [...messages, {
      id: payload?.messageId || activeReplyId,
      role: "sophia" as const,
      content: finalContent,
      createdAt: Date.now(),
      status: "complete" as const,
      turnId: payload?.turnId,
      audioUrl: payload?.audioUrl,
    }]
  }

  // Update the placeholder with final content
  return messages.map((m, i) =>
    i === placeholderIndex
      ? {
          ...m,
          content: finalContent,
          status: "complete" as const,
          turnId: payload?.turnId ?? m.turnId,
          audioUrl: payload?.audioUrl ?? m.audioUrl,
        }
      : m
  )
}

// =============================================================================
// History Load Deduplication
// =============================================================================

/**
 * Dedupe messages when loading from history.
 * Specifically handles the case where local and backend may have overlapping messages.
 */
export function dedupeHistoryLoad(
  localMessages: ChatMessage[],
  backendMessages: ChatMessage[]
): ChatMessage[] {
  // Create a set of backend message IDs for fast lookup
  const backendIds = new Set(backendMessages.map(m => m.id))
  const backendFingerprints = new Set(
    backendMessages.map(m => generateMessageFingerprint(m.role, m.createdAt, m.content))
  )

  // Filter local messages that aren't in backend
  const uniqueLocal = localMessages.filter(m => {
    if (backendIds.has(m.id)) return false
    const fingerprint = generateMessageFingerprint(m.role, m.createdAt, m.content)
    if (backendFingerprints.has(fingerprint)) return false
    return true
  })

  // Combine and sort
  const combined = [...backendMessages, ...uniqueLocal]
  return dedupeMessages(combined)
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate message list integrity.
 * Returns issues found (for debugging).
 */
export function validateMessages(messages: ChatMessage[]): string[] {
  const issues: string[] = []
  const ids = new Set<string>()
  
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    
    // Check for missing IDs
    if (!m.id) {
      issues.push(`Message at index ${i} has no ID`)
    }
    
    // Check for duplicate IDs
    if (m.id && ids.has(m.id)) {
      issues.push(`Duplicate message ID: ${m.id}`)
    }
    ids.add(m.id)
    
    // Check for missing content (except streaming)
    if (!m.content && m.status !== "streaming") {
      issues.push(`Message ${m.id} has no content (status: ${m.status})`)
    }
    
    // Check chronological order
    if (i > 0 && m.createdAt < messages[i - 1].createdAt) {
      issues.push(`Messages out of order at index ${i}`)
    }
  }
  
  return issues
}
