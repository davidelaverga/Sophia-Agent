import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthTokenMock = vi.fn();
const secureLogMock = vi.fn();

vi.mock('../../../app/lib/auth/server-auth', () => ({
  getUserScopedAuthToken: (...args: unknown[]) => getServerAuthTokenMock(...args),
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

  it('does not pre-read successful SSE responses for existing threads', async () => {
    const cloneTextMock = vi.fn().mockResolvedValue('event: message\ndata: ok\n\n');
    const upstreamResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      clone: vi.fn(() => ({ text: cloneTextMock })),
    } as unknown as Response;

    const fetchMock = vi.fn().mockResolvedValueOnce(upstreamResponse);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-existing-456',
      },
    );

    expect(result.threadId).toBe('thread-existing-456');
    expect(result.upstream).toBe(upstreamResponse);
    expect(upstreamResponse.clone).not.toHaveBeenCalled();
    expect(cloneTextMock).not.toHaveBeenCalled();
  });

  it('still retries stale 404 thread responses by reading the error body', async () => {
    const staleThreadCloneTextMock = vi.fn().mockResolvedValue('Thread or assistant not found');
    const staleThreadResponse = {
      ok: false,
      status: 404,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      clone: vi.fn(() => ({ text: staleThreadCloneTextMock })),
    } as unknown as Response;

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(staleThreadResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ thread_id: 'thread-fresh-789' }), {
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
      {
        ...basePayload,
        thread_id: 'thread-stale-123',
      },
    );

    expect(staleThreadResponse.clone).toHaveBeenCalledTimes(1);
    expect(staleThreadCloneTextMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:2026/api/langgraph/threads',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:2026/api/langgraph/threads/thread-fresh-789/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.threadId).toBe('thread-fresh-789');
    expect(result.upstream.status).toBe(200);
  });
});