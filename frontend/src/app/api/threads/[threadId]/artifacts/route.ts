import { type NextRequest, NextResponse } from 'next/server';

import {
  getUserScopedAuthHeader,
  refreshUserScopedAuthHeader,
} from '../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  const contentType = source.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  return headers;
}

async function proxyArtifactListRequest(
  req: NextRequest,
  threadId: string,
): Promise<Response> {
  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const url = new URL(`${BACKEND_URL}/api/threads/${encodeURIComponent(threadId)}/artifacts`);
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const execute = (authorization: string) => fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: authorization,
    },
    cache: 'no-store',
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  return proxyArtifactListRequest(req, threadId);
}