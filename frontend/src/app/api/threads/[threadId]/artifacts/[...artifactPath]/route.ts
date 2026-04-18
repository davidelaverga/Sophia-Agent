import { type NextRequest, NextResponse } from 'next/server';

import {
  getUserScopedAuthHeader,
  refreshUserScopedAuthHeader,
} from '../../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../../_lib/gateway-url';

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

function resolveArtifactRelativePath(
  req: NextRequest,
  threadId: string,
  artifactPathSegments: string[],
): string {
  // Prefer the raw pathname so we do not depend on Next.js segment parsing,
  // which on some deployments can drop or mangle the final file extension
  // (e.g. ".md") when it looks like a static asset. The authoritative source
  // is the incoming URL exactly as requested by the client.
  const pathname = req.nextUrl.pathname;
  const prefix = `/api/threads/${threadId}/artifacts/`;
  if (pathname.startsWith(prefix)) {
    const remainder = pathname.slice(prefix.length);
    if (remainder.length > 0) {
      // The pathname is already URL-encoded — forward it verbatim.
      return remainder;
    }
  }

  return artifactPathSegments
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function proxyArtifactRequest(
  req: NextRequest,
  threadId: string,
  artifactPathSegments: string[],
): Promise<Response> {
  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const encodedPath = resolveArtifactRelativePath(req, threadId, artifactPathSegments);
  const url = new URL(`${BACKEND_URL}/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodedPath}`);

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const execute = (authorization: string) => fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: authorization,
    },
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
  { params }: { params: Promise<{ threadId: string; artifactPath: string[] }> },
) {
  const { threadId, artifactPath } = await params;
  return proxyArtifactRequest(req, threadId, artifactPath || []);
}