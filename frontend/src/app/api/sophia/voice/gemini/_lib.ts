import { NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../_lib/sophia';

type GeminiProductionAuthResult = { userId: string } | { response: NextResponse };

export async function authorizeGeminiProductionUser(): Promise<GeminiProductionAuthResult> {
  const userId = await resolveSophiaUserId();

  if (!userId) {
    return {
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  return { userId };
}

export async function proxyGeminiProductionResponse(path: string, init: RequestInit): Promise<NextResponse> {
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