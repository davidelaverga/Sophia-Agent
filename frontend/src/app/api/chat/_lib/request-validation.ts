// Hard sanity ceiling on a single inbound chat message. This is NOT the
// old silent truncation of normal messages — it's an abuse guard against
// a pathological multi-megabyte payload. Messages longer than
// SPILL_THRESHOLD are spilled to a document attachment by the /api/chat
// post-handler (see message-spill.ts) rather than cut; only a message
// that somehow exceeds even this ceiling is clipped, as a last resort.
export const MAX_MESSAGE_CHARS = 1_000_000;

// Above this length the post-handler spills the FULL message to a thread
// attachment (which the companion reads via read_user_document) instead
// of sending it inline. At/under it, the message is forwarded inline
// verbatim. ~8k chars keeps a normal long message inline while routing
// transcript-sized pastes to the attachment path. Tunable.
export const SPILL_THRESHOLD = 8000;

// When a message is spilled, this many leading characters are kept inline
// as a preview so the model has immediate context and can decide whether
// to page through the rest of the document via read_user_document.
export const HEAD_PREVIEW_CHARS = 2000;

const VALID_SESSION_TYPES = ['prepare', 'debrief', 'reset', 'vent', 'chat', 'open_chat', 'open'] as const;
const VALID_CONTEXT_MODES = ['gaming', 'work', 'life'] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sanitizeMessage(input: string): string {
  if (typeof input !== 'string') return '';

  // Strip control characters, then trim. NO silent length truncation —
  // a long message is preserved in full here and routed to the spill
  // path downstream. The MAX_MESSAGE_CHARS slice is only an abuse guard.
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized.trim().slice(0, MAX_MESSAGE_CHARS);
}

export function validateSessionType(input: string | undefined): string {
  if (!input) return 'open_chat';
  const normalized = input.toLowerCase().replace(/[^a-z_]/g, '');
  if (normalized === 'open' || normalized === 'open_chat') return 'chat';
  return VALID_SESSION_TYPES.includes(normalized as typeof VALID_SESSION_TYPES[number])
    ? normalized
    : 'chat';
}

export function validateContextMode(input: string | undefined): string {
  if (!input) return 'life';
  const normalized = input.toLowerCase().replace(/[^a-z]/g, '');
  return VALID_CONTEXT_MODES.includes(normalized as typeof VALID_CONTEXT_MODES[number])
    ? normalized
    : 'life';
}

export function isValidSessionId(sessionId: string): boolean {
  return UUID_REGEX.test(sessionId);
}

export function extractRawMessage(payload: Record<string, unknown>): string {
  const messages = payload.messages as Array<Record<string, unknown>> | undefined;
  const lastMessage = messages?.[messages.length - 1];

  if (lastMessage?.parts && Array.isArray(lastMessage.parts)) {
    const textPart = lastMessage.parts.find((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'text') as { text?: string } | undefined;
    return textPart?.text || '';
  }

  if (typeof lastMessage?.content === 'string') {
    return lastMessage.content;
  }

  return (typeof payload.message === 'string' ? payload.message : '');
}