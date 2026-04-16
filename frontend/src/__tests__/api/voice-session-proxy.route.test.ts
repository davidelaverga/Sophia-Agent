import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSophiaUserIdMock = vi.fn();
const fetchSophiaApiMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
}));

import { POST as connectPOST } from '../../app/api/sophia/[userId]/voice/connect/route';
import { POST as disconnectPOST } from '../../app/api/sophia/[userId]/voice/disconnect/route';
import { GET as eventsGET } from '../../app/api/sophia/[userId]/voice/events/route';
import { POST as warmupPOST } from '../../app/api/sophia/[userId]/voice/warmup/route';

describe('voice session proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-1');
  });

  it('rejects voice connect when the Better Auth user does not match the URL userId', async () => {
    const response = await connectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-2/voice/connect?foo=bar'),
        text: async () => '{}',
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-2' }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Token does not grant access to this user' });
  });

  it('rejects voice disconnect when there is no authenticated Better Auth user', async () => {
    resolveSophiaUserIdMock.mockResolvedValue(null);

    const response = await disconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/disconnect'),
        text: async () => '{}',
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated' });
  });

  it('proxies voice connect with the user-scoped bearer token for the matching user', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, session_id: 'voice-session-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await connectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/connect?source=ui'),
        text: async () => JSON.stringify({ platform: 'voice' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/connect?source=ui');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify({ platform: 'voice' }));
    expect(response.status).toBe(200);
  });

  it('proxies voice warmup with the user-scoped bearer token for the matching user', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const response = await warmupPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/warmup'),
        text: async () => JSON.stringify({ call_id: 'call-123', session_id: 'session-456' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/warmup');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify({ call_id: 'call-123', session_id: 'session-456' }));
    expect(response.status).toBe(204);
  });

  it('proxies voice disconnect with the user-scoped bearer token for the matching user', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const response = await disconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/disconnect'),
        text: async () => JSON.stringify({ call_id: 'call-123' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/disconnect');
    expect(options.method).toBe('POST');
    expect(options.keepalive).toBe(true);
    expect(options.body).toBe(JSON.stringify({ call_id: 'call-123' }));
    expect(response.status).toBe(204);
  });

  it('proxies voice events with the user-scoped bearer token for the matching user', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: sophia.turn\ndata: {"type":"sophia.turn","data":{"phase":"agent_started"}}\n\n',
          ),
        );
        controller.close();
      },
    });

    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const response = await eventsGET(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/events?call_id=call-123&session_id=session-456'),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/events?call_id=call-123&session_id=session-456');
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await expect(response.text()).resolves.toContain('sophia.turn');
  });
});