import { describe, expect, it } from 'vitest';

import { parseAndValidateChatPayload } from '../../../app/api/chat/_lib/chat-request';
import { SPILL_THRESHOLD } from '../../../app/api/chat/_lib/request-validation';

describe('parseAndValidateChatPayload', () => {
  it('returns error when message is missing', () => {
    const result = parseAndValidateChatPayload({ session_id: 'sess_valid_123' });

    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.response.status).toBe(400);
    }
  });

  it('returns error when session id is invalid', () => {
    const result = parseAndValidateChatPayload({
      messages: [{ role: 'user', content: 'hello' }],
      session_id: 'invalid session with spaces',
    });

    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.response.status).toBe(400);
    }
  });

  it('returns validated payload for valid request', () => {
    const result = parseAndValidateChatPayload({
      messages: [{ role: 'user', content: 'Hello Sophia' }],
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      thread_id: 'thread_1',
      session_type: 'chat',
      context_mode: 'life',
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.data.userMessage).toBe('Hello Sophia');
      expect(result.data.sessionId).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(result.data.threadId).toBe('thread_1');
      expect(result.data.sessionType).toBe('chat');
      expect(result.data.contextMode).toBe('life');
    }
  });

  it('preserves overlong messages in full (no inline truncation — spilled downstream)', () => {
    // Regression guard for the spill feature: the validator must NOT cut
    // the message. A message past SPILL_THRESHOLD is forwarded intact and
    // the /api/chat post-handler spills it to a document attachment.
    const longMessage = 'a'.repeat(SPILL_THRESHOLD + 75);
    const result = parseAndValidateChatPayload({
      messages: [{ role: 'user', content: longMessage }],
      session_id: '123e4567-e89b-12d3-a456-426614174000',
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      // Full length preserved — the old slice(0, 2000) is gone.
      expect(result.data.userMessage).toHaveLength(SPILL_THRESHOLD + 75);
      expect(result.data.rawMessageLength).toBe(SPILL_THRESHOLD + 75);
    }
  });

  it('normalizes invalid session/context inputs to safe defaults', () => {
    const result = parseAndValidateChatPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      session_type: '!!!unknown_type###',
      context_mode: '???not-a-context',
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.data.sessionType).toBe('chat');
      expect(result.data.contextMode).toBe('life');
    }
  });
});
