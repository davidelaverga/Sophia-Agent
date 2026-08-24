import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSophiaUserIdMock = vi.fn();
const fetchSophiaApiMock = vi.fn();
const voiceLabMocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return {
    getConnectCapability: vi.fn(),
    getSessionCreateCapability: vi.fn(),
    getSessionReadCapability: vi.fn(),
    getEndSessionCapability: vi.fn(),
    getPrincipalConfig: vi.fn(),
    CapabilityError,
  };
});

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
}));

vi.mock('../../server/voice-lab/capability', () => ({
  getVoiceLabConnectCapability: (...args: unknown[]) => voiceLabMocks.getConnectCapability(...args),
  getVoiceLabSessionCreateCapability: (...args: unknown[]) => voiceLabMocks.getSessionCreateCapability(...args),
  getVoiceLabSessionReadCapability: (...args: unknown[]) => voiceLabMocks.getSessionReadCapability(...args),
  getVoiceLabEndSessionCapability: (...args: unknown[]) => voiceLabMocks.getEndSessionCapability(...args),
  getVoiceLabPrincipalConfig: (...args: unknown[]) => voiceLabMocks.getPrincipalConfig(...args),
  VOICE_LAB_CAPABILITY_HEADER: 'X-Sophia-Voice-Lab-Capability',
  VoiceLabCapabilityError: voiceLabMocks.CapabilityError,
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
import { POST as geminiProductionActivatePOST } from '../../app/api/sophia/voice/gemini/activate/route';
import { POST as geminiProductionDisconnectPOST } from '../../app/api/sophia/voice/gemini/disconnect/route';
import { GET as geminiProductionEventsGET } from '../../app/api/sophia/voice/gemini/events/route';
import { POST as geminiProductionRelayPOST } from '../../app/api/sophia/voice/gemini/relay/route';

describe('voice session proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-1');
    voiceLabMocks.getConnectCapability.mockResolvedValue(null);
    voiceLabMocks.getSessionCreateCapability.mockResolvedValue(null);
    voiceLabMocks.getSessionReadCapability.mockResolvedValue(null);
    voiceLabMocks.getEndSessionCapability.mockResolvedValue(null);
    voiceLabMocks.getPrincipalConfig.mockReturnValue({
      principalId: 'user-1',
      email: 'voice-lab@example.com',
      environment: 'production',
    });
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

  it('forwards the HttpOnly synthetic capability only on voice connect', async () => {
    voiceLabMocks.getConnectCapability.mockResolvedValue('gateway-capability');
    fetchSophiaApiMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await connectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice-lab-user-1/voice/connect'),
        text: async () => JSON.stringify({ platform: 'voice' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(response.status).toBe(200);
    const [, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toEqual({ 'X-Sophia-Voice-Lab-Capability': 'gateway-capability' });
  });

  it('rejects an invalid synthetic context before calling the gateway', async () => {
    voiceLabMocks.getConnectCapability.mockRejectedValue(
      new voiceLabMocks.CapabilityError('voice_lab_capability_expired_or_not_yet_valid', 401),
    );
    const response = await connectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/user-1/voice/connect'),
        text: async () => JSON.stringify({ platform: 'voice' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'user-1' }) },
    );

    expect(response.status).toBe(401);
    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
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

  it('proxies the exact synthetic browser activation receipt through the governed lane', async () => {
    voiceLabMocks.getSessionCreateCapability.mockResolvedValue('session-create-capability');
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ activated: true, provider_connection_epoch: 1 }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = {
      schema: 'sophia_voice_lab_browser_provider_activation_v1',
      session_id: 'gemini-prod-1',
      previous_activated_epoch: 0,
      candidate_epoch: 1,
    };

    const response = await geminiProductionActivatePOST({
      nextUrl: new URL('http://localhost:3000/api/sophia/voice/gemini/activate'),
      text: async () => JSON.stringify(body),
    } as unknown as NextRequest);

    expect(response.status).toBe(202);
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-1/voice/gemini/activate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'X-Sophia-Voice-Lab-Capability': 'session-create-capability' },
      }),
      { voiceLabAccess: 'governed' },
    );
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
    expect(fetchSophiaApiMock.mock.calls[0][2]).toEqual({ voiceLabAccess: 'governed' });
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

  it('uses provider cleanup authority after the interactive context expires', async () => {
    const token = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
    fetchSophiaApiMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const response = await geminiProductionDisconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/gemini/disconnect'),
        headers: new Headers({
          'X-Sophia-Voice-Lab-Provider-Cleanup': token,
        }),
        text: async () => JSON.stringify({ session_id: 'gemini-prod-1' }),
      } as unknown as NextRequest,
    );

    expect(response.status).toBe(204);
    expect(voiceLabMocks.getEndSessionCapability).not.toHaveBeenCalled();
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-1/voice/gemini/disconnect',
      expect.objectContaining({
        headers: { 'X-Sophia-Voice-Lab-Provider-Cleanup': token },
      }),
      { voiceLabAccess: 'governed' },
    );
  });

  it('rejects a malformed provider cleanup authority before gateway allocation', async () => {
    const response = await geminiProductionDisconnectPOST(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/voice/gemini/disconnect'),
        headers: new Headers({
          'X-Sophia-Voice-Lab-Provider-Cleanup': 'not-a-token',
        }),
        text: async () => JSON.stringify({ session_id: 'gemini-prod-1' }),
      } as unknown as NextRequest,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'voice_lab_provider_cleanup_malformed',
    });
    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
    expect(voiceLabMocks.getEndSessionCapability).not.toHaveBeenCalled();
  });
});
