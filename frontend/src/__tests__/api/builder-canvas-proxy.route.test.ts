import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSophiaUserIdMock: vi.fn(() => 'user-1'),
  fetchSophiaApiMock: vi.fn(),
}));

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: () => mocks.resolveSophiaUserIdMock(),
  fetchSophiaApi: (...args: unknown[]) => mocks.fetchSophiaApiMock(...args),
}));

import { GET as getCanvasEvents } from '../../app/api/sophia/builder/threads/[parentThreadId]/canvas/events/route';
import { GET as getCanvasSnapshot } from '../../app/api/sophia/builder/threads/[parentThreadId]/canvas/snapshot/route';

describe('builder canvas browser proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSophiaUserIdMock.mockReturnValue('user-1');
  });

  it('proxies snapshot through the authenticated user-scoped gateway route', async () => {
    mocks.fetchSophiaApiMock.mockResolvedValueOnce(new Response(JSON.stringify({
      version: 1,
      active_task: null,
      recent_events: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const response = await getCanvasSnapshot({} as NextRequest, {
      params: Promise.resolve({ parentThreadId: 'thread-1' }),
    });

    expect(mocks.fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-1/threads/thread-1/builder-canvas/snapshot',
      { method: 'GET', cache: 'no-store' },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      active_task: null,
      recent_events: [],
    });
  });

  it('preserves the streaming body and Last-Event-ID for canvas events', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: event-1\ndata: {}\n\n'));
        controller.close();
      },
    });
    mocks.fetchSophiaApiMock.mockResolvedValueOnce(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const request = {
      headers: new Headers({ 'Last-Event-ID': 'event-0' }),
    } as unknown as NextRequest;
    const response = await getCanvasEvents(request, {
      params: Promise.resolve({ parentThreadId: 'thread-1' }),
    });

    expect(mocks.fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-1/threads/thread-1/builder-canvas/events',
      {
        method: 'GET',
        cache: 'no-store',
        headers: { 'Last-Event-ID': 'event-0' },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    await expect(response.text()).resolves.toContain('id: event-1');
  });

  it('rejects unauthenticated snapshot access before hitting the gateway', async () => {
    mocks.resolveSophiaUserIdMock.mockReturnValueOnce(null);

    const response = await getCanvasSnapshot({} as NextRequest, {
      params: Promise.resolve({ parentThreadId: 'thread-1' }),
    });

    expect(response.status).toBe(401);
    expect(mocks.fetchSophiaApiMock).not.toHaveBeenCalled();
  });
});
