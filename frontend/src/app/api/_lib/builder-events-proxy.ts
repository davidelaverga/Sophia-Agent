import { type NextRequest, NextResponse } from 'next/server';

import {
  getVoiceLabSessionReadCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

import { fetchSophiaApi, resolveSophiaUserId } from './sophia';

type BuilderEventsProxyKind = 'stream' | 'last';

function failure(error: unknown): NextResponse | null {
  if (error instanceof VoiceLabCapabilityError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return null;
}

function responseHeaders(upstream: Response, kind: BuilderEventsProxyKind): Headers {
  const headers = new Headers();
  headers.set(
    'Content-Type',
    upstream.headers.get('content-type')
      ?? (kind === 'stream' ? 'text/event-stream' : 'application/json'),
  );
  headers.set('Cache-Control', 'no-store, no-transform');
  if (kind === 'stream') {
    headers.set('Connection', 'keep-alive');
    headers.set('X-Accel-Buffering', 'no');
  }
  return headers;
}

/**
 * Keep user-scoped Gateway authorization and the HttpOnly synthetic run
 * capability on the server. The browser sees only a same-origin SSE/JSON
 * endpoint, never a bearer token or capability in JS/query parameters.
 */
export async function proxyBuilderEvents(
  request: NextRequest,
  threadId: string,
  kind: BuilderEventsProxyKind,
): Promise<Response> {
  const userId = await resolveSophiaUserId({ voiceLabAccess: 'governed' });
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let capability: string | null;
  try {
    capability = await getVoiceLabSessionReadCapability(userId);
  } catch (error) {
    const response = failure(error);
    if (response) return response;
    throw error;
  }

  const headers = new Headers({
    Accept: kind === 'stream' ? 'text/event-stream' : 'application/json',
  });
  const lastEventId = request.headers.get('last-event-id');
  if (kind === 'stream' && lastEventId) {
    headers.set('Last-Event-ID', lastEventId.slice(0, 256));
  }
  if (capability) {
    headers.set(VOICE_LAB_CAPABILITY_HEADER, capability);
  }

  const suffix = kind === 'last' ? '/last' : '';
  const upstream = await fetchSophiaApi(
    `/api/threads/${encodeURIComponent(threadId)}/builder-events${suffix}`,
    {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: request.signal,
    },
    { voiceLabAccess: 'governed' },
  );

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream, kind),
  });
}
