import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return {
    resolveSophiaUserIdMock: vi.fn(() => 'user-1'),
    fetchSophiaApiMock: vi.fn(),
    getSessionReadCapabilityMock: vi.fn(),
    getEndSessionCapabilityMock: vi.fn(),
    CapabilityError,
  };
});

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: () => mocks.resolveSophiaUserIdMock(),
  fetchSophiaApi: (...args: unknown[]) => mocks.fetchSophiaApiMock(...args),
}));

vi.mock('../../server/voice-lab/capability', () => ({
  getVoiceLabSessionReadCapability: (...args: unknown[]) => mocks.getSessionReadCapabilityMock(...args),
  getVoiceLabEndSessionCapability: (...args: unknown[]) => mocks.getEndSessionCapabilityMock(...args),
  VOICE_LAB_CAPABILITY_HEADER: 'X-Sophia-Voice-Lab-Capability',
  VoiceLabCapabilityError: mocks.CapabilityError,
}));

import { GET as getCanvasEvents } from '../../app/api/sophia/builder/threads/[parentThreadId]/canvas/events/route';
import { GET as getCanvasSnapshot } from '../../app/api/sophia/builder/threads/[parentThreadId]/canvas/snapshot/route';
import { POST as cancelLatestCanvasTask } from '../../app/api/sophia/builder/threads/[parentThreadId]/canvas/tasks/[taskId]/cancel/route';
import { POST as cancelExactCanvasRun } from '../../app/api/sophia/builder/threads/[parentThreadId]/canvas/tasks/[taskId]/runs/[runId]/cancel/route';

describe('builder canvas browser proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSophiaUserIdMock.mockReturnValue('user-1');
    mocks.getSessionReadCapabilityMock.mockResolvedValue(null);
    mocks.getEndSessionCapabilityMock.mockResolvedValue(null);
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
      { method: 'GET', cache: 'no-store', headers: undefined },
      { voiceLabAccess: 'governed' },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      active_task: null,
      recent_events: [],
    });
  });

  it('forwards the exact-run read capability for a synthetic snapshot', async () => {
    mocks.getSessionReadCapabilityMock.mockResolvedValueOnce('signed-read');
    mocks.fetchSophiaApiMock.mockResolvedValueOnce(Response.json({
      version: 1,
      active_task: null,
      recent_events: [],
    }));

    const response = await getCanvasSnapshot({} as NextRequest, {
      params: Promise.resolve({ parentThreadId: 'thread-lab' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-1/threads/thread-lab/builder-canvas/snapshot',
      expect.objectContaining({
        headers: { 'X-Sophia-Voice-Lab-Capability': 'signed-read' },
      }),
      { voiceLabAccess: 'governed' },
    );
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
      { voiceLabAccess: 'governed' },
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

  it('rejects a wrong-run read context before hitting the gateway', async () => {
    mocks.getSessionReadCapabilityMock.mockRejectedValueOnce(
      new mocks.CapabilityError('voice_lab_capability_wrong_principal', 403),
    );

    const response = await getCanvasSnapshot({} as NextRequest, {
      params: Promise.resolve({ parentThreadId: 'thread-lab' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.fetchSophiaApiMock).not.toHaveBeenCalled();
  });

  it('uses only the finalization capability for both synthetic cancel routes', async () => {
    mocks.getEndSessionCapabilityMock.mockResolvedValue('signed-finalize');
    mocks.fetchSophiaApiMock.mockResolvedValue(
      Response.json({ task_id: 'task-1', run_id: 'run-1', status: 'cancelled', detail: 'done' }),
    );

    const latest = await cancelLatestCanvasTask({} as NextRequest, {
      params: Promise.resolve({ parentThreadId: 'thread-lab', taskId: 'task-1' }),
    });
    const exact = await cancelExactCanvasRun({} as NextRequest, {
      params: Promise.resolve({ parentThreadId: 'thread-lab', taskId: 'task-1', runId: 'run-1' }),
    });

    expect(latest.status).toBe(200);
    expect(exact.status).toBe(200);
    expect(mocks.getEndSessionCapabilityMock).toHaveBeenCalledTimes(2);
    for (const call of mocks.fetchSophiaApiMock.mock.calls) {
      expect(call[1].headers).toEqual({
        'X-Sophia-Voice-Lab-Capability': 'signed-finalize',
      });
    }
  });
});
