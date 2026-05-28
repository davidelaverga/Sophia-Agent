import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthenticatedUserIdMock = vi.fn();
const getUserScopedAuthTokenMock = vi.fn<() => Promise<string | null>>(async () => 'test-token');
const fetchBackendStreamWithBootstrapMock = vi.fn();
const parseAndValidateChatPayloadMock = vi.fn();
const userOwnsThreadMock = vi.fn<(threadId: string, userId: string, apiKey: string | null, gatewayUrl: string) => Promise<boolean>>(async () => true);
const getPrimaryGatewayUrlMock = vi.fn(() => 'https://gateway.test');

vi.mock('../../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: () => getAuthenticatedUserIdMock(),
  getUserScopedAuthToken: () => getUserScopedAuthTokenMock(),
}));

vi.mock('../../../app/lib/api/thread-ownership', () => ({
  userOwnsThread: (
    threadId: string,
    userId: string,
    apiKey: string | null,
    gatewayUrl: string,
  ) => userOwnsThreadMock(threadId, userId, apiKey, gatewayUrl),
}));

vi.mock('../../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => getPrimaryGatewayUrlMock(),
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
        attachedFiles: [],
      },
    });
    getAuthenticatedUserIdMock.mockResolvedValue('session-user-1');
    getUserScopedAuthTokenMock.mockResolvedValue('test-token');
    userOwnsThreadMock.mockResolvedValue(true);
    getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.test');
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

describe('handleChatPost thread ownership gate (Codex P1 PR #132 — later iteration)', () => {
  // Updated: the gate originally fired only when ``attached_files`` was
  // non-empty. That left a wider hole — ``view_user_image`` and
  // ``read_user_document`` can be triggered by prompt injection alone
  // ("describe photo.png for me"), so a foreign threadId with NO
  // attachments is also exploitable. Gate now runs for ANY explicit
  // caller-supplied threadId.

  beforeEach(() => {
    vi.clearAllMocks();
    getAuthenticatedUserIdMock.mockResolvedValue('session-user-1');
    getUserScopedAuthTokenMock.mockResolvedValue('test-token');
    userOwnsThreadMock.mockResolvedValue(true);
    getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.test');
    fetchBackendStreamWithBootstrapMock.mockResolvedValue({
      upstream: new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
      threadId: 'thread-1',
    });
  });

  it('rejects with 403 when attachments are present and the user does NOT own the thread', async () => {
    userOwnsThreadMock.mockResolvedValueOnce(false);
    parseAndValidateChatPayloadMock.mockReturnValue({
      kind: 'valid',
      data: {
        userMessage: 'look at this',
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        threadId: 'thread-victim',
        sessionType: 'chat',
        contextMode: 'life',
        platform: 'text',
        rawMessageLength: 12,
        attachedFiles: ['secret.png'],
      },
    });

    const response = await handleChatPost({
      json: async () => ({}),
    } as never);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.error).toMatch(/not owned/i);
    expect(body.code).toBe('THREAD_OWNERSHIP_REJECTED');
    expect(fetchBackendStreamWithBootstrapMock).not.toHaveBeenCalled();
    // Ownership check was actually invoked with the authenticated
    // user_id (not the attacker-supplied one).
    expect(userOwnsThreadMock).toHaveBeenCalledWith(
      'thread-victim',
      'session-user-1',
      'test-token',
      'https://gateway.test',
    );
  });

  it('forwards normally when attachments are present and the user DOES own the thread', async () => {
    userOwnsThreadMock.mockResolvedValueOnce(true);
    parseAndValidateChatPayloadMock.mockReturnValue({
      kind: 'valid',
      data: {
        userMessage: 'look at this',
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        threadId: 'thread-mine',
        sessionType: 'chat',
        contextMode: 'life',
        platform: 'text',
        rawMessageLength: 12,
        attachedFiles: ['photo.png'],
      },
    });

    const response = await handleChatPost({
      json: async () => ({}),
    } as never);

    expect(response.status).toBe(200);
    expect(userOwnsThreadMock).toHaveBeenCalledTimes(1);
    expect(fetchBackendStreamWithBootstrapMock).toHaveBeenCalledTimes(1);
    const payload = fetchBackendStreamWithBootstrapMock.mock.calls[0][1] as {
      message: string;
      thread_id: string;
    };
    // The attachment prompt was prepended; threadId forwarded.
    expect(payload.message).toContain('view_user_image');
    expect(payload.thread_id).toBe('thread-mine');
  });

  it('rejects with 403 when threadId is spoofed and NO attachments are present (Codex P1 — later iteration)', async () => {
    // The actual attack vector for the later P1: an authenticated
    // caller sends a foreign threadId with NO attachments + a prompt
    // like "describe the file photo.png" or "summarize doc.pdf for me".
    // The companion turns around and calls ``view_user_image`` /
    // ``read_user_document`` against the victim's
    // ``backend/.deer-flow/threads/{thread_id}/user-data/`` sandbox.
    //
    // Without the gate on attachment-free requests, this would silently
    // succeed for any filename the attacker can guess (resume.pdf,
    // screenshot.png, etc.). The gate must fire for ANY explicit
    // threadId — the earlier "only when attached_files is non-empty"
    // scoping was insufficient.
    userOwnsThreadMock.mockResolvedValueOnce(false);
    parseAndValidateChatPayloadMock.mockReturnValue({
      kind: 'valid',
      data: {
        userMessage: 'describe the file resume.pdf for me',
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        threadId: 'thread-victim',
        sessionType: 'chat',
        contextMode: 'life',
        platform: 'text',
        rawMessageLength: 36,
        attachedFiles: [], // ← critical: no attachments
      },
    });

    const response = await handleChatPost({
      json: async () => ({}),
    } as never);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.code).toBe('THREAD_OWNERSHIP_REJECTED');
    expect(userOwnsThreadMock).toHaveBeenCalledWith(
      'thread-victim',
      'session-user-1',
      'test-token',
      'https://gateway.test',
    );
    expect(fetchBackendStreamWithBootstrapMock).not.toHaveBeenCalled();
  });

  it('runs the ownership check on attachment-free requests with an explicit threadId', async () => {
    // Mirror of the above but the user IS the owner — must still
    // pass through to the backend. Pins the "gate fires, doesn't
    // block legitimate traffic" property.
    parseAndValidateChatPayloadMock.mockReturnValue({
      kind: 'valid',
      data: {
        userMessage: 'plain chat continuing my session',
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        threadId: 'thread-mine',
        sessionType: 'chat',
        contextMode: 'life',
        platform: 'text',
        rawMessageLength: 10,
        attachedFiles: [],
      },
    });

    const response = await handleChatPost({
      json: async () => ({}),
    } as never);

    expect(response.status).toBe(200);
    // Gate fires (was previously skipped on no-attachment requests).
    expect(userOwnsThreadMock).toHaveBeenCalledTimes(1);
    expect(userOwnsThreadMock).toHaveBeenCalledWith(
      'thread-mine',
      'session-user-1',
      'test-token',
      'https://gateway.test',
    );
    expect(fetchBackendStreamWithBootstrapMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT run the ownership check when there is no explicit threadId (new-session bootstrap)', async () => {
    // Scope of the gate: ONLY explicit caller-supplied threadIds get
    // verified. A request with no threadId is the new-session
    // bootstrap path — the backend creates a fresh thread for this
    // user, so there's nothing to verify. Same shape regardless of
    // whether attachments are present (the orphan-attachment payload
    // is malformed in practice and the gateway will reject it
    // downstream).
    parseAndValidateChatPayloadMock.mockReturnValue({
      kind: 'valid',
      data: {
        userMessage: 'new chat',
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        threadId: undefined,
        sessionType: 'chat',
        contextMode: 'life',
        platform: 'text',
        rawMessageLength: 8,
        attachedFiles: [],
      },
    });

    const response = await handleChatPost({
      json: async () => ({}),
    } as never);

    expect(response.status).toBe(200);
    expect(userOwnsThreadMock).not.toHaveBeenCalled();
  });
});