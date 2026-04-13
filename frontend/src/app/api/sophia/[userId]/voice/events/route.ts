import { type NextRequest, NextResponse } from 'next/server';

import { getAuthenticatedUserId, getUserScopedAuthHeader } from '../../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../../_lib/gateway-url';

export const dynamic = 'force-dynamic';

const BACKEND_URL = getPrimaryGatewayUrl();

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const authenticatedUserId = await getAuthenticatedUserId();

  if (!authenticatedUserId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  if (authenticatedUserId !== userId) {
    return NextResponse.json({ error: 'Token does not grant access to this user' }, { status: 403 });
  }

  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const url = new URL(`${BACKEND_URL}/api/sophia/${encodeURIComponent(userId)}/voice/events`);

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const backendResponse = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      Authorization: authHeader,
    },
    cache: 'no-store',
  });

  if (!backendResponse.ok || !backendResponse.body) {
    const responseText = await backendResponse.text().catch(() => '');
    return new NextResponse(responseText || null, {
      status: backendResponse.status,
      headers: responseText
        ? {
            'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
          }
        : undefined,
    });
  }

  return new NextResponse(backendResponse.body, {
    status: backendResponse.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}