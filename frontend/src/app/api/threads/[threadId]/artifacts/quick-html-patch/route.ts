import { type NextRequest, NextResponse } from 'next/server';

import {
  getUserScopedAuthHeader,
  refreshUserScopedAuthHeader,
} from '../../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

function copyJsonResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  const contentType = source.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  return headers;
}

async function proxyQuickPatchRequest(
  req: NextRequest,
  threadId: string,
): Promise<Response> {
  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await req.text();
  const url = new URL(`${BACKEND_URL}/api/threads/${encodeURIComponent(threadId)}/artifacts/quick-html-patch`);

  const execute = (authorization: string) => fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': req.headers.get('content-type') || 'application/json',
      Accept: 'application/json',
    },
    body,
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
    headers: copyJsonResponseHeaders(backendResponse.headers),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  return proxyQuickPatchRequest(req, threadId);
}
