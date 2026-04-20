import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';

export const dynamic = 'force-dynamic';

async function authorizeVoiceConnect(userId: string) {
  const authenticatedUserId = await resolveSophiaUserId();

  if (!authenticatedUserId) {
    return { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  if (authenticatedUserId !== userId) {
    return { response: NextResponse.json({ error: 'Token does not grant access to this user' }, { status: 403 }) };
  }

  return { ok: true };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorizeVoiceConnect(userId);

  if ('response' in auth) {
    return auth.response;
  }

  const backendResponse = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/voice/connect${req.nextUrl.search}`,
    {
    method: 'POST',
    body: await req.text(),
    },
  );

  const responseText = await backendResponse.text();

  return new NextResponse(responseText, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
    },
  });
}