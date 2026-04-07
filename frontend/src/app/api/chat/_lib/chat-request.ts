import { secureLog } from './config';
import {
  extractRawMessage,
  isValidSessionId,
  MAX_MESSAGE_LENGTH,
  sanitizeMessage,
  validateContextMode,
  validateSessionType,
} from './request-validation';

export interface ValidatedChatRequest {
  userMessage: string;
  sessionId: string;
  userId: string;
  threadId?: string;
  sessionType: ReturnType<typeof validateSessionType>;
  contextMode: ReturnType<typeof validateContextMode>;
  platform: string | undefined;
  rawMessageLength: number;
}

export type ParseChatRequestResult =
  | { kind: 'valid'; data: ValidatedChatRequest }
  | { kind: 'invalid'; response: Response };

export function parseAndValidateChatPayload(payload: unknown): ParseChatRequestResult {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  const rawMessage = extractRawMessage(record);
  const userMessage = sanitizeMessage(rawMessage);

  if (!userMessage) {
    return {
      kind: 'invalid',
      response: new Response(
        JSON.stringify({ error: 'Message is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    };
  }

  const sessionId = String(record.session_id || record.sessionId || 'default-session');
  const userId = String(record.user_id || record.userId || 'anonymous');
  const threadIdCandidate = record.thread_id || record.threadId || record.backend_thread_id || record.backendThreadId;
  const threadId = typeof threadIdCandidate === 'string' ? threadIdCandidate : undefined;
  const sessionTypeInput = typeof (record.session_type || record.sessionType) === 'string'
    ? String(record.session_type || record.sessionType)
    : undefined;
  const contextModeInput = typeof (record.context_mode || record.contextMode) === 'string'
    ? String(record.context_mode || record.contextMode)
    : undefined;
  const sessionType = validateSessionType(sessionTypeInput);
  const contextMode = validateContextMode(contextModeInput);
  const platform = typeof record.platform === 'string' ? record.platform : undefined;

  if (!isValidSessionId(sessionId)) {
    secureLog('[/api/chat] Invalid session_id, rejecting request', {
      sessionId,
    });
    return {
      kind: 'invalid',
      response: new Response(
        JSON.stringify({ error: 'Invalid session_id. Start a session first.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    };
  }

  secureLog('[/api/chat] Validated request:', {
    sessionId: `${sessionId.slice(0, 20)}...`,
    sessionType,
    contextMode,
    messageLength: userMessage.length,
    truncated: rawMessage.length > MAX_MESSAGE_LENGTH,
  });

  return {
    kind: 'valid',
    data: {
      userMessage,
      sessionId,
      userId,
      threadId,
      sessionType,
      contextMode,
      platform,
      rawMessageLength: rawMessage.length,
    },
  };
}
