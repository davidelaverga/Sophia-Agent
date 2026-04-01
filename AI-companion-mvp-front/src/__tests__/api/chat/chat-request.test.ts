import { describe, expect, it } from 'vitest';
import { parseAndValidateChatPayload } from '../../../app/api/chat/_lib/chat-request';
import { MAX_MESSAGE_LENGTH } from '../../../app/api/chat/_lib/request-validation';

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
      user_id: 'user_1',
      session_type: 'chat',
      context_mode: 'life',
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.data.userMessage).toBe('Hello Sophia');
      expect(result.data.sessionId).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(result.data.userId).toBe('user_1');
      expect(result.data.sessionType).toBe('chat');
      expect(result.data.contextMode).toBe('life');
    }
  });

  it('truncates overlong messages while preserving raw length metadata', () => {
    const longMessage = 'a'.repeat(MAX_MESSAGE_LENGTH + 75);
    const result = parseAndValidateChatPayload({
      messages: [{ role: 'user', content: longMessage }],
      session_id: '123e4567-e89b-12d3-a456-426614174000',
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.data.userMessage).toHaveLength(MAX_MESSAGE_LENGTH);
      expect(result.data.rawMessageLength).toBe(MAX_MESSAGE_LENGTH + 75);
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
