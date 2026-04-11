import { type NextRequest, NextResponse } from 'next/server';

import { getAuthenticatedUserId, getUserScopedAuthHeader } from '../../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

export async function POST(
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

  const url = new URL(`${BACKEND_URL}/api/sophia/${encodeURIComponent(userId)}/voice/connect`);

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const backendResponse = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: await req.text(),
  });

  const responseText = await backendResponse.text();

  return new NextResponse(responseText, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
    },
  });
}