/**
 * Conversation Messages Proxy
 * =============================
 * 
 * GET /api/conversation/[sessionId]/messages?limit=30&before=...
 * 
 * Proxies to backend: GET /api/v1/conversations/sessions/{sessionId}/messages
 * Auth from httpOnly cookie (server-side).
 */

import { type NextRequest, NextResponse } from 'next/server';

import { getUserScopedAuthHeader } from '../../../../lib/auth/server-auth';
import { logger } from '../../../../lib/error-logger';

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const authHeader = await getUserScopedAuthHeader();

  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID required' }, { status: 400 });
  }

  // Forward query params
  const { searchParams } = new URL(req.url);
  const qs = new URLSearchParams();
  
  const limit = searchParams.get('limit') || '30';
  qs.set('limit', limit);
  
  const before = searchParams.get('before');
  if (before) qs.set('before', before);

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/conversations/sessions/${sessionId}/messages?${qs}`,
      {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      return new NextResponse(body, {
        status: response.status,
        headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
      });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    logger.logError(error, { component: 'api/conversation/messages', action: 'fetch_messages' });
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 502 });
  }
}
