import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi } from '../../../../_lib/sophia';

import { authorizeGeminiProductionUser } from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authorizeGeminiProductionUser();

  if ('response' in auth) {
    return auth.response;
  }

  const backendResponse = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(auth.userId)}/voice/gemini/events${req.nextUrl.search}`,
    {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    },
  );

  if (!backendResponse.body) {
    const responseText = await backendResponse.text();
    return new NextResponse(responseText || null, {
      status: backendResponse.status,
      headers: responseText
        ? {
            'Content-Type': backendResponse.headers.get('content-type') ?? 'application/json',
          }
        : undefined,
    });
  }

  return new NextResponse(backendResponse.body, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') ?? 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
}