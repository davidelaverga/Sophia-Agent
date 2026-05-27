import { NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../_lib/sophia';

export async function authorizeOpenAIDogfoodUser(userId: string) {
  const authenticatedUserId = await resolveSophiaUserId();

  if (!authenticatedUserId) {
    return { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  if (authenticatedUserId !== userId) {
    return { response: NextResponse.json({ error: 'Token does not grant access to this user' }, { status: 403 }) };
  }

  return { ok: true };
}

export async function proxyOpenAIDogfoodResponse(path: string, init: RequestInit) {
  const backendResponse = await fetchSophiaApi(path, init);
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
