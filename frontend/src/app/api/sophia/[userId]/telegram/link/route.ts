import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';

export const dynamic = 'force-dynamic';

async function authorize(userId: string) {
  const authenticatedUserId = await resolveSophiaUserId();

  if (!authenticatedUserId) {
    return { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  if (authenticatedUserId !== userId) {
    return { response: NextResponse.json({ error: 'Token does not grant access to this user' }, { status: 403 }) };
  }

  return { ok: true as const };
}

function buildBackendPath(userId: string) {
  return `/api/sophia/${encodeURIComponent(userId)}/telegram/link`;
}

async function forwardResponse(backend: Response) {
  const body = await backend.text();
  return new NextResponse(body, {
    status: backend.status,
    headers: {
      'Content-Type': backend.headers.get('content-type') || 'application/json',
    },
  });
}

async function forwardEmpty(backend: Response) {
  // Only 204 responses have no body; everything else flows through forwardResponse.
  if (backend.status === 204) {
    return new NextResponse(null, { status: 204 });
  }
  return forwardResponse(backend);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorize(userId);
  if ('response' in auth) {
    return auth.response;
  }

  const backend = await fetchSophiaApi(buildBackendPath(userId), {
    method: 'POST',
    body: '{}',
  });
  return forwardResponse(backend);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorize(userId);
  if ('response' in auth) {
    return auth.response;
  }

  const backend = await fetchSophiaApi(buildBackendPath(userId), {
    method: 'GET',
  });
  return forwardResponse(backend);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorize(userId);
  if ('response' in auth) {
    return auth.response;
  }

  const backend = await fetchSophiaApi(buildBackendPath(userId), {
    method: 'DELETE',
  });
  return forwardEmpty(backend);
}
