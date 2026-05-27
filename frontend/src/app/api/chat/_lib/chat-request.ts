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
  threadId?: string;
  sessionType: ReturnType<typeof validateSessionType>;
  contextMode: ReturnType<typeof validateContextMode>;
  platform: string | undefined;
  rawMessageLength: number;
  /**
   * Bare filenames the user uploaded for this turn (via the attachments
   * bar) — the post-handler prepends a brief context block so Sophia
   * knows to call `view_user_image` / `read_user_document` on them.
   * Filtered to safe bare filenames (no slashes, no traversal).
   */
  attachedFiles: string[];
}

// Cap matches AttachmentBar's per-message upload count — and the
// per-turn prompt-tokens we're willing to spend naming files. 12 is
// generous for typical "look at these 3 screenshots" UX and bounded
// enough that a malicious client can't blow the system prompt budget.
const MAX_ATTACHED_FILES_PER_TURN = 12;

function sanitizeAttachedFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  // The companion's view_user_image / read_user_document tools take a
  // bare filename. Anything containing a path separator OR a leading
  // dot (hidden file) is rejected — same rules the tools enforce
  // server-side (see view_user_image.py::_is_safe_filename).
  if (/[\\/]/.test(trimmed)) return null;
  if (trimmed.startsWith('.')) return null;
  // Defensive length cap — filenames over 255 chars don't survive most
  // filesystems and a 1k-char garbage string is almost certainly an
  // attack/bug.
  if (trimmed.length > 255) return null;
  return trimmed;
}

function extractAttachedFiles(record: Record<string, unknown>): string[] {
  const raw = record.attached_files ?? record.attachedFiles;
  if (!Array.isArray(raw)) return [];
  const cleaned: string[] = [];
  for (const entry of raw) {
    const safe = sanitizeAttachedFilename(entry);
    if (safe !== null && !cleaned.includes(safe)) {
      cleaned.push(safe);
    }
    if (cleaned.length >= MAX_ATTACHED_FILES_PER_TURN) break;
  }
  return cleaned;
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

  const attachedFiles = extractAttachedFiles(record);

  return {
    kind: 'valid',
    data: {
      userMessage,
      sessionId,
      threadId,
      sessionType,
      contextMode,
      platform,
      rawMessageLength: rawMessage.length,
      attachedFiles,
    },
  };
}
