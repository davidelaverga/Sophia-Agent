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
import { POST as geminiBrowserDogfoodPOST } from '../../app/api/sophia/[userId]/voice/dogfood/gemini/browser-session/route';
import { POST as geminiBrowserDogfoodRelayPOST } from '../../app/api/sophia/[userId]/voice/dogfood/gemini/relay/route';
import { POST as openAIBrowserDogfoodPOST } from '../../app/api/sophia/[userId]/voice/dogfood/openai/browser-session/route';
import { POST as openAIBrowserDogfoodDisconnectPOST } from '../../app/api/sophia/[userId]/voice/dogfood/openai/disconnect/route';
import { GET as eventsGET } from '../../app/api/sophia/[userId]/voice/events/route';
import { POST as warmupPOST } from '../../app/api/sophia/[userId]/voice/warmup/route';
import { POST as geminiStableBrowserDogfoodPOST } from '../../app/api/sophia/voice/dogfood/gemini/browser-session/route';
import { POST as geminiStableDisconnectPOST } from '../../app/api/sophia/voice/dogfood/gemini/disconnect/route';
import { GET as geminiStableEventsGET } from '../../app/api/sophia/voice/dogfood/gemini/events/route';
import { POST as geminiStableRelayPOST } from '../../app/api/sophia/voice/dogfood/gemini/relay/route';
import { POST as geminiProductionDisconnectPOST } from '../../app/api/sophia/voice/gemini/disconnect/route';
import { GET as geminiProductionEventsGET } from '../../app/api/sophia/voice/gemini/events/route';
import { POST as geminiProductionRelayPOST } from '../../app/api/sophia/voice/gemini/relay/route';

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

  it('proxies voice events with the resume cursor for the matching user', async () => {
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
        headers: new Headers({ 'Last-Event-ID': '7' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/events?call_id=call-123&session_id=session-456');
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect((options.headers as Record<string, string>)['Last-Event-ID']).toBe('7');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await expect(response.text()).resolves.toContain('sophia.turn');
  });

  it('proxies OpenAI browser dogfood session start with the user-scoped bearer token', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ session_id: 'browser-openai-1', client_secret: { value: 'ek_test' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await openAIBrowserDogfoodPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/dogfood/openai/browser-session'),
        text: async () => JSON.stringify({ session_id: 'browser-openai-1' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/openai/browser-session');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify({ session_id: 'browser-openai-1' }));
    expect(response.status).toBe(201);
  });

  it('proxies OpenAI browser dogfood disconnect safely when the backend returns 204 with no body', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const response = await openAIBrowserDogfoodDisconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/dogfood/openai/disconnect'),
        text: async () => JSON.stringify({ session_id: 'browser-openai-1' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/openai/disconnect');
    expect(options.method).toBe('POST');
    expect(options.keepalive).toBe(true);
    expect(options.body).toBe(JSON.stringify({ session_id: 'browser-openai-1' }));
    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });

  it('preserves non-500 OpenAI dogfood disconnect errors from the backend proxy', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Dogfood session with id 'browser-openai-1' not found" }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await openAIBrowserDogfoodDisconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/dogfood/openai/disconnect'),
        text: async () => JSON.stringify({ session_id: 'browser-openai-1' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ detail: "Dogfood session with id 'browser-openai-1' not found" });
  });

  it('proxies Gemini browser dogfood session start with the user-scoped bearer token', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ session_id: 'browser-gemini-1', ephemeral_token: { value: 'auth_tokens/test' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await geminiBrowserDogfoodPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/dogfood/gemini/browser-session'),
        text: async () => JSON.stringify({ session_id: 'browser-gemini-1' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/gemini/browser-session');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify({ session_id: 'browser-gemini-1' }));
    expect(response.status).toBe(201);
  });

  it('proxies Gemini browser dogfood event relay with the user-scoped bearer token', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: true, session_id: 'browser-gemini-1' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = {
      session_id: 'browser-gemini-1',
      event: { serverContent: { outputTranscription: { text: 'Hi.' } } },
    };
    const response = await geminiBrowserDogfoodRelayPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/dogfood/gemini/relay'),
        text: async () => JSON.stringify(body),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/gemini/relay');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify(body));
    expect(response.status).toBe(202);
  });

  it('proxies stable Gemini browser dogfood session start through the authenticated user and rewrites the event stream URL', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session_id: 'browser-gemini-1',
          ephemeral_token: { value: 'auth_tokens/test' },
          stream_url: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const response = await geminiStableBrowserDogfoodPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/dogfood/gemini/browser-session'),
        text: async () => JSON.stringify({ session_id: 'browser-gemini-1' }),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/gemini/browser-session');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify({ session_id: 'browser-gemini-1' }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      session_id: 'browser-gemini-1',
      stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1',
      event_stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1',
    });
  });

  it('proxies stable Gemini browser dogfood event relay through the authenticated user', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: true, session_id: 'browser-gemini-1' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = {
      session_id: 'browser-gemini-1',
      event: { serverContent: { outputTranscription: { text: 'Hi.' } } },
    };
    const response = await geminiStableRelayPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/dogfood/gemini/relay'),
        text: async () => JSON.stringify(body),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/gemini/relay');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify(body));
    expect(response.status).toBe(202);
  });

  it('proxies stable Gemini browser dogfood events with the resume cursor', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'));
        controller.close();
      },
    });

    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const response = await geminiStableEventsGET(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1'),
        headers: new Headers({ 'Last-Event-ID': '11' }),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1');
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect((options.headers as Record<string, string>)['Last-Event-ID']).toBe('11');
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('event: ping');
  });

  it('proxies stable Gemini browser dogfood disconnect safely when the backend returns 204 with no body', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const response = await geminiStableDisconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/dogfood/gemini/disconnect'),
        text: async () => JSON.stringify({ session_id: 'browser-gemini-1' }),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/dogfood/gemini/disconnect');
    expect(options.method).toBe('POST');
    expect(options.keepalive).toBe(true);
    expect(options.body).toBe(JSON.stringify({ session_id: 'browser-gemini-1' }));
    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });

  it('proxies production Gemini relay through the authenticated user', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: true, session_id: 'gemini-prod-1' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = {
      session_id: 'gemini-prod-1',
      event: { setupComplete: {} },
    };
    const response = await geminiProductionRelayPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/gemini/relay'),
        text: async () => JSON.stringify(body),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/gemini/relay');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify(body));
    expect(response.status).toBe(202);
  });

  it('logs safe production Gemini relay metadata when backend rejects the relay', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Gemini Live toolCall omitted functionCalls.' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = {
      session_id: 'gemini-prod-sensitive-session',
      event: { serverContent: { inputTranscription: { text: 'private transcript' } } },
      provider_receive_sequence: 42,
      provider_relay_sequence: 7,
      relay_correlation_id: 'gemini-relay-42',
      provider_primary_category: 'inputTranscription',
      provider_categories: ['serverContent', 'inputTranscription'],
    };
    const response = await geminiProductionRelayPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/gemini/relay'),
        text: async () => JSON.stringify(body),
      } as unknown as NextRequest,
    );

    expect(response.status).toBe(422);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const serializedLog = JSON.stringify(warnSpy.mock.calls);
    expect(serializedLog).toContain('gemini-relay-42');
    expect(serializedLog).toContain('inputTranscription');
    expect(serializedLog).toContain('Gemini Live toolCall omitted functionCalls.');
    expect(serializedLog).not.toContain('private transcript');
    warnSpy.mockRestore();
  });

  it('proxies production Gemini events with the header and query resume cursors', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: sophia.turn\ndata: {}\n\n'));
        controller.close();
      },
    });

    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const response = await geminiProductionEventsGET(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/gemini/events?session_id=gemini-prod-1&last_event_id=12'),
        headers: new Headers({ 'Last-Event-ID': '12' }),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/gemini/events?session_id=gemini-prod-1&last_event_id=12');
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect((options.headers as Record<string, string>)['Last-Event-ID']).toBe('12');
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('sophia.turn');
  });

  it('proxies production Gemini disconnect safely when the backend returns 204 with no body', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const response = await geminiProductionDisconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/gemini/disconnect'),
        text: async () => JSON.stringify({ session_id: 'gemini-prod-1' }),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/voice/gemini/disconnect');
    expect(options.method).toBe('POST');
    expect(options.keepalive).toBe(true);
    expect(options.body).toBe(JSON.stringify({ session_id: 'gemini-prod-1' }));
    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });
});
