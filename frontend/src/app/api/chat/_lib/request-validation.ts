export const MAX_MESSAGE_LENGTH = 2000;
const VALID_SESSION_TYPES = ['prepare', 'debrief', 'reset', 'vent', 'chat', 'open_chat', 'open'] as const;
const VALID_CONTEXT_MODES = ['gaming', 'work', 'life'] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sanitizeMessage(input: string): string {
  if (typeof input !== 'string') return '';

   
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized.slice(0, MAX_MESSAGE_LENGTH).trim();
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