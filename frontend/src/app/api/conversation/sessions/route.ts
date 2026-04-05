/**
 * Conversation Sessions Proxy
 * ============================
 * 
 * GET /api/conversation/sessions?page=1&page_size=20
 * 
 * Proxies to backend: GET /api/v1/conversations/sessions
 * Auth from httpOnly cookie (server-side).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthHeader, getServerAuthToken } from '../../../lib/auth/server-auth';
import { logger } from '../../../lib/error-logger';

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function GET(req: NextRequest) {
  const token = getServerAuthToken();

  if (!token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Forward query params as-is
  const { searchParams } = new URL(req.url);
  const params = new URLSearchParams();
  
  const page = searchParams.get('page') || '1';
  const pageSize = searchParams.get('page_size') || '20';
  params.set('page', page);
  params.set('page_size', pageSize);

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/conversations/sessions?${params}`,
      {
        headers: {
          'Authorization': getServerAuthHeader(),
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      // Forward 404/501 transparently so client can handle "not implemented" gracefully
      const body = await response.text();
      return new NextResponse(body, {
        status: response.status,
        headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
      });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    logger.logError(error, { component: 'api/conversation/sessions', action: 'fetch_sessions' });
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 502 });
  }
}
