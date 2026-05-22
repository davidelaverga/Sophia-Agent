import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi } from '../../../../../_lib/sophia';

import { authorizeGeminiDogfoodUser, buildStableGeminiDogfoodEventsUrl } from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authorizeGeminiDogfoodUser();

  if ('response' in auth) {
    return auth.response;
  }

  const backendResponse = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(auth.userId)}/voice/dogfood/gemini/browser-session${req.nextUrl.search}`,
    {
      method: 'POST',
      body: await req.text(),
    },
  );
  const responseText = await backendResponse.text();

  if (!responseText) {
    return new NextResponse(null, { status: backendResponse.status });
  }

  const contentType = backendResponse.headers.get('content-type') ?? 'application/json';

  if (!contentType.includes('application/json')) {
    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: { 'Content-Type': contentType },
    });
  }

  let payload: Record<string, unknown> | null = null;

  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = { ...parsed };
    }
  } catch {
    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: { 'Content-Type': contentType },
    });
  }

  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null;

  if (sessionId) {
    const streamUrl = buildStableGeminiDogfoodEventsUrl(sessionId);
    payload.stream_url = streamUrl;
    payload.event_stream_url = streamUrl;
  }

  return NextResponse.json(payload, { status: backendResponse.status });
}