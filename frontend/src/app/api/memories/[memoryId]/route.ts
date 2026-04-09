import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, isSyntheticMemoryId, resolveSophiaUserId } from '../../_lib/sophia';

async function resolveMemoryRequest(
  req: NextRequest,
  params: Promise<{ memoryId: string }>,
): Promise<{ memoryId: string; userId: string } | NextResponse> {
  const { memoryId } = await params;

  if (!memoryId) {
    return NextResponse.json({ error: 'memoryId is required' }, { status: 400 });
  }

  const userId = await resolveSophiaUserId(req.nextUrl.searchParams.get('user_id'));
  if (!userId) {
    return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401 });
  }

  return { memoryId, userId };
}

async function passthroughBackendResponse(backendResponse: Response): Promise<Response> {
  if (backendResponse.status === 204) {
    return new NextResponse(null, { status: 204 });
  }

  const responseText = await backendResponse.text();

  return new NextResponse(responseText, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
    },
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ memoryId: string }> }
) {
  try {
    const resolved = await resolveMemoryRequest(req, params);
    if (resolved instanceof NextResponse) {
      return resolved;
    }

    const { memoryId, userId } = resolved;

    if (isSyntheticMemoryId(memoryId)) {
      return NextResponse.json({ error: 'Synthetic memories cannot be updated' }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid update payload' }, { status: 400 });
    }

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      }
    );

    return passthroughBackendResponse(backendResponse);
  } catch (error) {
    logger.logError(error, { component: 'api/memories/[memoryId]', action: 'update_memory' });
    return NextResponse.json({ error: 'Failed to update memory' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ memoryId: string }> }
) {
  try {
    const resolved = await resolveMemoryRequest(req, params);
    if (resolved instanceof NextResponse) {
      return resolved;
    }

    const { memoryId, userId } = resolved;

    if (isSyntheticMemoryId(memoryId)) {
      return new NextResponse(null, { status: 204 });
    }

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'DELETE',
      }
    );

    return passthroughBackendResponse(backendResponse);
  } catch (error) {
    logger.logError(error, { component: 'api/memories/[memoryId]', action: 'delete_memory' });
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 500 });
  }
}
