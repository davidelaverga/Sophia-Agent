import { NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';

type GeminiDogfoodAuthResult = { userId: string } | { response: NextResponse };

export async function authorizeGeminiDogfoodUser(): Promise<GeminiDogfoodAuthResult> {
  const userId = await resolveSophiaUserId();

  if (!userId) {
    return {
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  return { userId };
}

export function buildStableGeminiDogfoodEventsUrl(sessionId: string): string {
  const searchParams = new URLSearchParams({ session_id: sessionId });
  return `/api/sophia/voice/dogfood/gemini/events?${searchParams.toString()}`;
}

export async function proxyGeminiDogfoodResponse(path: string, init: RequestInit): Promise<NextResponse> {
  const backendResponse = await fetchSophiaApi(path, init);
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