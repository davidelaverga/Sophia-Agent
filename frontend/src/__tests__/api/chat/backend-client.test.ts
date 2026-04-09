import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthTokenMock = vi.fn();
const secureLogMock = vi.fn();

vi.mock('../../../app/lib/auth/server-auth', () => ({
  getServerAuthToken: (...args: unknown[]) => getServerAuthTokenMock(...args),
}));

vi.mock('../../../app/api/chat/_lib/config', () => ({
  IS_PRODUCTION: false,
  SOPHIA_ASSISTANT_ID: 'sophia_companion',
  secureLog: (...args: unknown[]) => secureLogMock(...args),
}));

import {
  fetchBackendStreamWithBootstrap,
  type BackendStreamPayload,
} from '../../../app/api/chat/_lib/backend-client';

const basePayload: BackendStreamPayload = {
  message: 'Hello Sophia',
  session_id: '123e4567-e89b-12d3-a456-426614174000',
  user_id: 'user-123',
  context_mode: 'life',
  platform: 'text',
  language: 'en',
};

describe('fetchBackendStreamWithBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerAuthTokenMock.mockResolvedValue('');
  });

  it('falls back to direct LangGraph when the local proxy bootstrap request fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ thread_id: 'thread-live-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      basePayload,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:2026/api/langgraph/threads',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:2024/threads',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:2024/threads/thread-live-123/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.threadId).toBe('thread-live-123');
    expect(result.upstream.status).toBe(200);
    expect(secureLogMock).toHaveBeenCalledWith(
      '[/api/chat] local langgraph proxy unavailable, retrying direct backend',
      expect.objectContaining({ fallbackBackendUrl: 'http://127.0.0.1:2024/threads' }),
    );
  });

  it('falls back to direct LangGraph when an existing thread hits a proxy 503', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('proxy unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-existing-123',
      },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:2026/api/langgraph/threads/thread-existing-123/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:2024/threads/thread-existing-123/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.threadId).toBe('thread-existing-123');
    expect(result.upstream.status).toBe(200);
  });
});