import { describe, expect, it } from 'vitest';

import { resolveChatStreamProtocol } from '../../../app/api/chat/_lib/stream-protocol';

describe('resolveChatStreamProtocol', () => {
  it('defaults to data protocol when header is missing', () => {
    expect(resolveChatStreamProtocol(undefined)).toBe('data');
    expect(resolveChatStreamProtocol(null)).toBe('data');
    expect(resolveChatStreamProtocol('')).toBe('data');
  });

  it('uses data protocol for explicit data value', () => {
    expect(resolveChatStreamProtocol('data')).toBe('data');
    expect(resolveChatStreamProtocol(' DATA ')).toBe('data');
  });

  it('ignores legacy protocol headers and keeps data protocol', () => {
    expect(resolveChatStreamProtocol('text')).toBe('data');
    expect(resolveChatStreamProtocol('legacy')).toBe('data');
  });

  it('keeps data protocol for any unknown or malformed header values', () => {
    expect(resolveChatStreamProtocol('text/plain')).toBe('data');
    expect(resolveChatStreamProtocol('application/json')).toBe('data');
    expect(resolveChatStreamProtocol('v2')).toBe('data');
    expect(resolveChatStreamProtocol('   legacy,text   ')).toBe('data');
  });
});
