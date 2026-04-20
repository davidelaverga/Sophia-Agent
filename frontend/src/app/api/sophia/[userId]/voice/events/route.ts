import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const authenticatedUserId = await resolveSophiaUserId();

  if (!authenticatedUserId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  if (authenticatedUserId !== userId) {
    return NextResponse.json({ error: 'Token does not grant access to this user' }, { status: 403 });
  }

  const backendResponse = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/voice/events${req.nextUrl.search}`,
    {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
    },
    cache: 'no-store',
    },
  );

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