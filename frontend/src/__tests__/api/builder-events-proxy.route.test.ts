import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return {
    fetchSophiaApi: vi.fn(),
    resolveSophiaUserId: vi.fn(),
    getSessionReadCapability: vi.fn(),
    CapabilityError,
  };
});

vi.mock('../../app/api/_lib/sophia', () => ({
  fetchSophiaApi: (...args: unknown[]) => mocks.fetchSophiaApi(...args),
  resolveSophiaUserId: (...args: unknown[]) => mocks.resolveSophiaUserId(...args),
}));

vi.mock('../../server/voice-lab/capability', () => ({
  getVoiceLabSessionReadCapability: (...args: unknown[]) => mocks.getSessionReadCapability(...args),
  VOICE_LAB_CAPABILITY_HEADER: 'X-Sophia-Voice-Lab-Capability',
  VoiceLabCapabilityError: mocks.CapabilityError,
}));

import { GET as streamGET } from '../../app/api/threads/[threadId]/builder-events/route';
import { GET as lastGET } from '../../app/api/threads/[threadId]/builder-events/last/route';

function request(headers?: HeadersInit): NextRequest {
  return new Request('https://sophia.example/api/threads/thread-1/builder-events', {
    headers,
  }) as NextRequest;
}

describe('Builder event same-origin proxies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSophiaUserId.mockResolvedValue('user-123');
    mocks.getSessionReadCapability.mockResolvedValue(null);
  });

  it('rejects an unauthenticated browser before capability lookup or Gateway work', async () => {
    mocks.resolveSophiaUserId.mockResolvedValue(null);

    const response = await streamGET(request(), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated' });
    expect(mocks.getSessionReadCapability).not.toHaveBeenCalled();
    expect(mocks.fetchSophiaApi).not.toHaveBeenCalled();
  });

  it('streams ordinary-user SSE through same-origin auth without a lab capability', async () => {
    mocks.fetchSophiaApi.mockResolvedValue(new Response('data: {"status":"success"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const response = await streamGET(request({ 'Last-Event-ID': 'event-7' }), {
      params: Promise.resolve({ threadId: 'thread/with spaces' }),
    });

    expect(mocks.getSessionReadCapability).toHaveBeenCalledWith('user-123');
    expect(mocks.fetchSophiaApi).toHaveBeenCalledWith(
      '/api/threads/thread%2Fwith%20spaces/builder-events',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
      { voiceLabAccess: 'governed' },
    );
    const headers = new Headers(mocks.fetchSophiaApi.mock.calls[0][1].headers);
    expect(headers.get('Accept')).toBe('text/event-stream');
    expect(headers.get('Last-Event-ID')).toBe('event-7');
    expect(headers.has('X-Sophia-Voice-Lab-Capability')).toBe(false);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    await expect(response.text()).resolves.toBe('data: {"status":"success"}\n\n');
  });

  it('forwards the HttpOnly exact-run capability server-side for synthetic SSE', async () => {
    mocks.getSessionReadCapability.mockResolvedValue('signed-session-read-capability');
    mocks.fetchSophiaApi.mockResolvedValue(new Response('data: {}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const response = await streamGET(request(), {
      params: Promise.resolve({ threadId: 'thread-lab' }),
    });

    const headers = new Headers(mocks.fetchSophiaApi.mock.calls[0][1].headers);
    expect(headers.get('X-Sophia-Voice-Lab-Capability')).toBe(
      'signed-session-read-capability',
    );
    expect(response.status).toBe(200);
  });

  it('passes through Gateway wrong-run rejection without opening an SSE stream', async () => {
    mocks.getSessionReadCapability.mockResolvedValue('wrong-run-capability');
    mocks.fetchSophiaApi.mockResolvedValue(new Response(JSON.stringify({
      detail: 'voice_lab_session_binding_mismatch',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));

    const response = await streamGET(request(), {
      params: Promise.resolve({ threadId: 'thread-lab' }),
    });

    expect(response.status).toBe(409);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      detail: 'voice_lab_session_binding_mismatch',
    });
  });

  it('rejects an invalid synthetic context before Gateway work', async () => {
    mocks.getSessionReadCapability.mockRejectedValue(
      new mocks.CapabilityError('voice_lab_capability_wrong_principal', 403),
    );

    const response = await streamGET(request(), {
      params: Promise.resolve({ threadId: 'thread-lab' }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'voice_lab_capability_wrong_principal',
    });
    expect(mocks.fetchSophiaApi).not.toHaveBeenCalled();
  });

  it('proxies the late-mount JSON endpoint and preserves a no-event 204', async () => {
    mocks.fetchSophiaApi.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await lastGET(request(), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(mocks.fetchSophiaApi).toHaveBeenCalledWith(
      '/api/threads/thread-1/builder-events/last',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
      { voiceLabAccess: 'governed' },
    );
    const headers = new Headers(mocks.fetchSophiaApi.mock.calls[0][1].headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(response.status).toBe(204);
  });
});
