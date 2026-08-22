import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi } from '../../../../../../_lib/sophia';
import { authorizeOpenAIDogfoodUser } from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorizeOpenAIDogfoodUser(userId);

  if ('response' in auth) {
    return auth.response;
  }

  const lastEventId = req.headers?.get('last-event-id');

  const backendResponse = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/voice/dogfood/openai/events${req.nextUrl.search}`,
    {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
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
