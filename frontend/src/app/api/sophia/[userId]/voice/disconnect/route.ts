import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';

export async function POST(
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
    `/api/sophia/${encodeURIComponent(userId)}/voice/disconnect${req.nextUrl.search}`,
    {
    method: 'POST',
    body: await req.text(),
    keepalive: true,
    },
  );

  const responseText = await backendResponse.text();

  return new NextResponse(responseText || null, {
    status: backendResponse.status,
    headers: responseText
      ? {
          'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
        }
      : undefined,
  });
}