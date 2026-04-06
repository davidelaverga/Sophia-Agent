/**
 * Stream Recovery Utility
 * Phase 4 Week 4 - Resume Stream UX
 * 
 * Handles recovery from SSE stream disconnections by:
 * 1. Waiting for backend to potentially complete processing
 * 2. Checking if response already exists in DB
 * 3. Deciding whether to show existing response or queue for retry
 * 
 * Based on backend behavior: Backend ALWAYS completes even if client disconnects.
 * This means the response is likely already saved when we detect the failure.
 */

import { getStoredToken } from '../stores/auth-token-store';

import { logger } from './error-logger';

// =============================================================================
// TYPES
// =============================================================================

export interface RecoveryOptions {
  /** Session ID to check messages for */
  sessionId: string;
  /** The user message content that was sent */
  lastUserMessage: string;
  /** Timestamp when disconnection was detected */
  disconnectedAt: number;
  /** Maximum time to wait for backend completion (default: 30s) */
  maxWaitMs?: number;
  /** Minimum wait before checking (default: 5s) */
  minWaitMs?: number;
}

export interface RecoveryResult {
  /** Whether frontend should retry sending the message */
  shouldRetry: boolean;
  /** Existing response from Sophia if found */
  existingResponse?: string;
  /** Message ID of existing response (for feedback, etc) */
  existingMessageId?: string;
  /** Reason for the decision */
  reason: 'response_found' | 'no_response' | 'check_failed' | 'timeout';
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'sophia' | 'system';
  content: string;
  created_at: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_MIN_WAIT_MS = 5000;  // Wait 5s for backend to complete
const DEFAULT_MAX_WAIT_MS = 30000; // Max 30s (matches Anthropic timeout)
const MESSAGES_LIMIT = 10;         // Only need recent messages
const RECOVERY_WINDOW_MS = 3 * 60 * 1000;
const DISCONNECT_CLOCK_SKEW_MS = 15 * 1000;

const LEAKED_USER_MESSAGE_BLOCK = /(?:^|\n)\s*USER(?:\s*_?\s*MESSAGE)?\s*:[\s\S]*$/i;
const NATURAL_RESPONSE_PLACEHOLDER_LINE = /(?:^|\n)\s*\[Natural response above\]\s*(?=\n|$)/gi;

// =============================================================================
// MAIN RECOVERY FUNCTION
// =============================================================================

/**
 * Verify if the backend already processed the message before re-sending.
 * Avoids duplicates without requiring backend changes.
 * 
 * @param options - Recovery configuration
 * @returns Recovery result with decision and potential existing response
 */
export async function recoverFromDisconnect(
  options: RecoveryOptions
): Promise<RecoveryResult> {
  const {
    sessionId,
    lastUserMessage,
    disconnectedAt,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    minWaitMs = DEFAULT_MIN_WAIT_MS,
  } = options;

  logger.debug('StreamRecovery', 'Starting recovery check', {
    sessionId,
    messagePreview: lastUserMessage.substring(0, 50),
    disconnectedAt,
  });

  // 1. Wait minimum time for backend to complete (if it was processing)
  const timeSinceDisconnect = Date.now() - disconnectedAt;
  if (timeSinceDisconnect < minWaitMs) {
    const waitTime = minWaitMs - timeSinceDisconnect;
    logger.debug('StreamRecovery', 'Waiting for backend to complete', { waitTime });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  // 2. Check if we've exceeded max wait time
  if (Date.now() - disconnectedAt > maxWaitMs) {
    logger.debug('StreamRecovery', 'Max wait time exceeded, allowing retry');
    return {
      shouldRetry: true,
      reason: 'timeout',
    };
  }

  // 3. Fetch recent messages from session
  try {
    const messages = await fetchSessionMessages(sessionId, MESSAGES_LIMIT);
    
    if (!messages || messages.length === 0) {
      logger.debug('StreamRecovery', 'No messages found, allowing retry');
      return {
        shouldRetry: true,
        reason: 'no_response',
      };
    }

    // 4. Find if user message was processed and has a response
    const result = findExistingResponse(messages, lastUserMessage, disconnectedAt);
    
    if (result.found) {
      logger.debug('StreamRecovery', 'Found existing response', {
        messageId: result.messageId,
        responsePreview: result.content?.substring(0, 50),
      });
      return {
        shouldRetry: false,
        existingResponse: result.content,
        existingMessageId: result.messageId,
        reason: 'response_found',
      };
    }

    logger.debug('StreamRecovery', 'No matching response found, allowing retry');
    return {
      shouldRetry: true,
      reason: 'no_response',
    };

  } catch (error) {
    // If check fails, it's safer to allow retry than to block the user
    logger.logError(error, {
      component: 'StreamRecovery',
      action: 'recoverFromDisconnect',
      sessionId,
    });
    return {
      shouldRetry: true,
      reason: 'check_failed',
    };
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Fetch recent messages from a session via the conversations API
 */
async function fetchSessionMessages(
  sessionId: string,
  limit: number
): Promise<ConversationMessage[]> {
  // Use local proxy — auth handled server-side (httpOnly cookie)
  const url = `/api/conversation/${sessionId}/messages?limit=${limit}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.status}`);
  }

  const data = await response.json();
  
  // Handle both { messages: [...] } and direct array responses
  return Array.isArray(data) ? data : (data.messages || []);
}

/**
 * Find if there's an existing Sophia response to the user's message
 */
function findExistingResponse(
  messages: ConversationMessage[],
  userMessageContent: string,
  disconnectedAt: number
): { found: boolean; content?: string; messageId?: string } {
  // Filter to recent messages (generous window to survive slower backends / client clock skew)
  const cutoffTime = disconnectedAt - RECOVERY_WINDOW_MS;
  const disconnectUpperBound = disconnectedAt + DISCONNECT_CLOCK_SKEW_MS;
  const recentMessages = messages.filter(
    m => new Date(m.created_at).getTime() > cutoffTime
  );

  // Sort by created_at ascending to find the sequence
  recentMessages.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Find the user message by content match - pick latest match, not first.
  const normalizedTarget = normalizeContent(userMessageContent);
  const matchingUserIndices = recentMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && normalizeContent(message.content) === normalizedTarget)
    .map(({ index }) => index);

  let userMsgIndex = matchingUserIndices.length > 0
    ? matchingUserIndices[matchingUserIndices.length - 1]
    : -1;

  // Fallback: if no exact match, use latest user message at/before disconnect time.
  if (userMsgIndex === -1) {
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const message = recentMessages[i];
      if (message.role !== 'user') continue;
      const createdAt = new Date(message.created_at).getTime();
      if (createdAt <= disconnectUpperBound) {
        userMsgIndex = i;
        break;
      }
    }
  }

  if (userMsgIndex === -1) {
    // User message not found in DB yet
    return { found: false };
  }

  // Look for Sophia's response after the user message and prefer latest valid content
  let bestCandidate: { found: boolean; content?: string; messageId?: string } = { found: false };
  for (let i = userMsgIndex + 1; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    if (msg.role === 'sophia') {
      const sanitized = sanitizeRecoveredContent(msg.content);
      if (!sanitized) continue;
      bestCandidate = {
        found: true,
        content: sanitized,
        messageId: msg.id,
      };
    }
  }

  if (bestCandidate.found) {
    return bestCandidate;
  }

  // User message exists but no Sophia response yet
  return { found: false };
}

/**
 * Normalize message content for comparison (trim, collapse whitespace)
 */
function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

function sanitizeRecoveredContent(content: string): string {
  if (!content) return '';
  const leakageMatch = content.match(LEAKED_USER_MESSAGE_BLOCK);
  let sanitized =
    leakageMatch && typeof leakageMatch.index === 'number'
      ? content.slice(0, leakageMatch.index)
      : content;

  sanitized = sanitized.replace(NATURAL_RESPONSE_PLACEHOLDER_LINE, '');
  return sanitized.trim();
}

// =============================================================================
// INTEGRATION HELPERS
// =============================================================================

/**
 * Check if we should attempt recovery (vs immediate retry)
 * Returns false if conditions aren't met for recovery check
 */
export function shouldAttemptRecovery(
  sessionId: string | null,
  userMessage: string | null
): boolean {
  // Need both session and message to check
  if (!sessionId || !userMessage) {
    return false;
  }
  
  // Need auth token
  if (!getStoredToken()) {
    return false;
  }

  return true;
}

/**
 * Create a recovery check with automatic timeout handling
 */
export async function recoverWithTimeout(
  options: RecoveryOptions,
  timeoutMs: number = 10000
): Promise<RecoveryResult> {
  return Promise.race([
    recoverFromDisconnect(options),
    new Promise<RecoveryResult>((resolve) => 
      setTimeout(() => resolve({
        shouldRetry: true,
        reason: 'timeout',
      }), timeoutMs)
    ),
  ]);
}

// =============================================================================
// TELEMETRY
// =============================================================================

export interface RecoveryTelemetry {
  sessionId: string;
  disconnectedAt: number;
  recoveryResult: RecoveryResult['reason'];
  durationMs: number;
  hadExistingResponse: boolean;
}

/**
 * Emit telemetry event for stream recovery
 */
export function emitRecoveryTelemetry(telemetry: RecoveryTelemetry): void {
  logger.debug('StreamRecovery', 'Telemetry', telemetry as unknown as Record<string, unknown>);
  
  // If we have a telemetry service, emit there too
  // emitTelemetry('stream.recovery', telemetry);
}
