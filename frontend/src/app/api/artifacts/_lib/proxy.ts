import { type NextRequest, NextResponse } from 'next/server';

import {
  getUserScopedAuthHeader,
  refreshUserScopedAuthHeader,
} from '../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const headerName of [
    'cache-control',
    'content-disposition',
    'content-length',
    'content-type',
    'etag',
    'last-modified',
  ]) {
    const value = source.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  return headers;
}

export async function proxyArtifactRegistryRequest(
  req: NextRequest,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string | null },
): Promise<Response> {
  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const url = new URL(`${BACKEND_URL}/api/artifacts${path}`);
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const execute = (authorization: string) => fetch(url.toString(), {
    method: init.method,
    headers: {
      Authorization: authorization,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ?? undefined,
    cache: 'no-store',
    redirect: 'follow',
  });

  let backendResponse = await execute(authHeader);

  if (backendResponse.status === 401) {
    const refreshedAuthHeader = await refreshUserScopedAuthHeader();
    if (refreshedAuthHeader && refreshedAuthHeader !== authHeader) {
      backendResponse = await execute(refreshedAuthHeader);
    }
  }

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    headers: copyResponseHeaders(backendResponse.headers),
  });
}
