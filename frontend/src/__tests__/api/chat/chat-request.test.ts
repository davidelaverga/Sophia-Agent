import { describe, expect, it } from 'vitest';

import { parseAndValidateChatPayload } from '../../../app/api/chat/_lib/chat-request';
import { SPILL_THRESHOLD } from '../../../app/api/chat/_lib/request-validation';

describe('parseAndValidateChatPayload', () => {
  const source = { thread_id: '30000000-0000-4000-8000-000000000001', command_key: 'original-action-key',
    message_id: 'original-message-id', content: 'SYNTHETIC ORIGINAL', expected_clear_epoch: 2 };
  it('preserves the original source action exactly through chat parsing', () => {
    const result = parseAndValidateChatPayload({ session_id: '20000000-0000-4000-8000-000000000001',
      thread_id: source.thread_id, message: source.content, memory_source_action: source });
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') expect(result.data.sourceAction).toEqual(source);
  });
  it('C2 refuses otherwise valid source attachment keys', () => {
    expect(parseAndValidateChatPayload({ session_id: '20000000-0000-4000-8000-000000000001',
      thread_id: source.thread_id, message: source.content, memory_source_action: source,
      memory_source_attachment_keys: ['association-one'] }).kind).toBe('invalid');
  });
  it.each([null, [], 'association-one', ['short'], ['association-one', 'association-one'],
    ['../wrong-key'], [12345678], Array.from({ length: 17 }, (_, i) => `association-${i}`)])(
    'rejects invalid present canonical references without downgrade %j', keys => {
      const result = parseAndValidateChatPayload({ session_id: '20000000-0000-4000-8000-000000000001',
        thread_id: source.thread_id, message: source.content, memory_source_action: source,
        memory_source_attachment_keys: keys });
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') expect(result.response.headers.get('cache-control')).toBe('no-store');
    });
  it('requires an exact source action for canonical references', () => {
    expect(parseAndValidateChatPayload({ session_id: '20000000-0000-4000-8000-000000000001',
      message: source.content, memory_source_attachment_keys: ['association-one'] }).kind).toBe('invalid');
  });
  it.each([{ attached_files: ['legacy.txt'] }, { attachedFiles: ['legacy.txt'] },
    { attached_files: ['../discarded.txt'] }, { attached_files: [] , attachedFiles: ['hidden.txt'] },
    { attached_files: 'malformed' }, { attachedFiles: null }])('rejects mixed legacy routing %j', files => {
    expect(parseAndValidateChatPayload({ session_id: '20000000-0000-4000-8000-000000000001',
      thread_id: source.thread_id, message: source.content, memory_source_action: source, ...files }).kind).toBe('invalid');
  });
  it.each([null, { ...source, content: 'SYNTHETIC CHANGED' }, { ...source, expected_clear_epoch: true },
    { ...source, owner_id: 'forged' }, { ...source, thread_id: '30000000-0000-4000-8000-000000000099' }])('denies malformed source action without downgrading %j', action => {
    const result = parseAndValidateChatPayload({ session_id: '20000000-0000-4000-8000-000000000001',
      thread_id: source.thread_id, message: source.content, memory_source_action: action });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.response.headers.get('cache-control')).toBe('no-store');
  });
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
