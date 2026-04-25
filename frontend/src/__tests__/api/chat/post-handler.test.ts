import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthenticatedUserIdMock = vi.fn();
const fetchBackendStreamWithBootstrapMock = vi.fn();
const parseAndValidateChatPayloadMock = vi.fn();

vi.mock('../../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: (...args: unknown[]) => getAuthenticatedUserIdMock(...args),
}));

vi.mock('../../../app/lib/rate-limiter', () => ({
  apiLimiters: {
    chat: {
      checkSync: vi.fn(() => true),
    },
  },
}));

vi.mock('../../../app/api/chat/_lib/backend-client', () => ({
  fetchBackendStreamWithBootstrap: (...args: unknown[]) => fetchBackendStreamWithBootstrapMock(...args),
  isValidSophiaUserId: (userId: string) => userId !== 'user..bad',
}));

vi.mock('../../../app/api/chat/_lib/chat-request', () => ({
  parseAndValidateChatPayload: (...args: unknown[]) => parseAndValidateChatPayloadMock(...args),
}));

vi.mock('../../../app/api/chat/_lib/config', () => ({
  AI_SDK_STREAM_HEADER: 'x-test-stream',
  BACKEND_CHAT_ENDPOINT: '/threads',
  BACKEND_URL: 'http://backend.test',
  IS_PRODUCTION: false,
  USE_MOCK: false,
  secureLog: vi.fn(),
}));

vi.mock('../../../app/api/chat/_lib/mock', () => ({
  getMockResponse: vi.fn(() => 'mock-response'),
}));

vi.mock('../../../app/api/chat/_lib/stream-transformers', () => ({
  createSSEToUIMessageStream: vi.fn(() => new ReadableStream()),
  createUIMessageStreamFromText: vi.fn(() => new ReadableStream()),
  normalizeArtifactsV1: vi.fn(() => null),
}));

vi.mock('../../../app/lib/error-logger', () => ({
  logger: {
    logError: vi.fn(),
  },
}));

import { handleChatPost } from '../../../app/api/chat/_lib/post-handler';

describe('handleChatPost auth hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseAndValidateChatPayloadMock.mockReturnValue({
      kind: 'valid',
      data: {
        userMessage: 'Hello Sophia',
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        threadId: 'thread-1',
        sessionType: 'chat',
        contextMode: 'life',
        platform: 'text',
        rawMessageLength: 12,
      },
    });
    getAuthenticatedUserIdMock.mockResolvedValue('session-user-1');
    fetchBackendStreamWithBootstrapMock.mockResolvedValue({
      upstream: new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
      threadId: 'thread-1',
    });
  });

  it('returns 401 when no authenticated user can be resolved', async () => {
    getAuthenticatedUserIdMock.mockResolvedValue(null);

    const response = await handleChatPost({
      json: async () => ({ message: 'Hello', user_id: 'attacker-user' }),
    } as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated' });
    expect(fetchBackendStreamWithBootstrapMock).not.toHaveBeenCalled();
  });

  it('ignores client user_id and forwards the authenticated server user id', async () => {
    await handleChatPost({
      json: async () => ({ message: 'Hello', user_id: 'attacker-user' }),
    } as never);

    expect(fetchBackendStreamWithBootstrapMock).toHaveBeenCalledWith(
      'http://backend.test/threads',
      expect.objectContaining({
        user_id: 'session-user-1',
        message: 'Hello Sophia',
      }),
    );
    expect(fetchBackendStreamWithBootstrapMock.mock.calls[0][1].user_id).not.toBe('attacker-user');
  });

  it('rejects invalid authenticated user_id before forwarding', async () => {
    getAuthenticatedUserIdMock.mockResolvedValue('user..bad');

    const response = await handleChatPost({
      json: async () => ({ message: 'Hello' }),
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid user_id format' });
    expect(fetchBackendStreamWithBootstrapMock).not.toHaveBeenCalled();
  });
});