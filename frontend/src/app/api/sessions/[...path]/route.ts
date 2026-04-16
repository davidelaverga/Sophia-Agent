/**
 * Sessions Proxy API Route
 * Proxies /api/sessions/* -> backend /api/v1/sessions/*
 */

import { type NextRequest, NextResponse } from 'next/server';

import { getUserScopedAuthHeader, refreshUserScopedAuthHeader } from '../../../lib/auth/server-auth';
import { debugLog } from '../../../lib/debug-logger';
import type { MicroBriefingIntent } from '../../../types/session';
import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

const MICRO_BRIEFING_COPY: Record<MicroBriefingIntent, string> = {
  interrupt_checkin: 'Pause for one breath. What matters most in the next few minutes?',
  quick_reset: 'Reset the frame. Name one thing you can release and one thing you want to keep.',
  reflection_prompt: 'What are you noticing underneath the surface right now?',
  nudge: 'A small check-in: do you want to stay with this thread, or shift your attention?',
};

function createAnonymousActiveSessionResponse() {
  return NextResponse.json({ has_active_session: false }, { status: 200 });
}

function createFallbackMicroBriefingResponse(rawBody: string | undefined) {
  let intent: MicroBriefingIntent = 'nudge';

  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as { intent?: MicroBriefingIntent };
      if (parsed.intent && parsed.intent in MICRO_BRIEFING_COPY) {
        intent = parsed.intent;
      }
    } catch {
      // Ignore malformed fallback payloads and use the default nudge copy.
    }
  }

  return NextResponse.json({
    message_id: `micro-${Date.now()}`,
    assistant_text: MICRO_BRIEFING_COPY[intent],
    highlights: [],
    ui_cards: [],
    briefing_source: 'fallback',
    has_memory: false,
  }, { status: 200 });
}

async function proxyRequest(req: NextRequest, pathSegments: string[]) {
  const path = pathSegments.join('/');
  const url = new URL(`${BACKEND_URL}/api/v1/sessions/${path}`);
  const authHeader = await getUserScopedAuthHeader();

  if (!authHeader) {
    if (req.method === 'GET' && path === 'active') {
      return createAnonymousActiveSessionResponse();
    }

    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  
  debugLog('sessions proxy', 'Request', { method: req.method, path, url: url.toString() });

  // Preserve query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  // 🔒 SECURITY: Read token from httpOnly cookie server-side
  const method = req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await req.text();

  const execute = (authorization: string) => fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authorization,
    },
    body,
  });

  let backendResponse = await execute(authHeader);

  if (backendResponse.status === 401) {
    const refreshedAuthHeader = await refreshUserScopedAuthHeader();
    if (refreshedAuthHeader && refreshedAuthHeader !== authHeader) {
      backendResponse = await execute(refreshedAuthHeader);
    }
  }

  if ((backendResponse.status === 401 || backendResponse.status === 404 || backendResponse.status === 405) && method === 'GET' && path === 'active') {
    return createAnonymousActiveSessionResponse();
  }

  if (backendResponse.status === 404 && method === 'POST' && path === 'micro-briefing') {
    return createFallbackMicroBriefingResponse(body);
  }

  const responseText = await backendResponse.text();
  
  debugLog('sessions proxy', 'Response', {
    status: backendResponse.status,
    preview: responseText.slice(0, 200),
  });

  return new NextResponse(responseText, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
    },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyRequest(req, path || []);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyRequest(req, path || []);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyRequest(req, path || []);
}
