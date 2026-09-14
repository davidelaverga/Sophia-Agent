import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../lib/error-logger';
import { canonicalCommandResponse } from '../../_lib/memory-command-response';
import { forwardCanonicalLifecycle } from '../../_lib/memory-lifecycle-response';
import { fetchSophiaApi, isSyntheticMemoryId, resolveSophiaUserId } from '../../_lib/sophia';

function isLocalReviewMemoryId(memoryId: string): boolean {
  return memoryId.startsWith('local:');
}

function isBlockedSyntheticMemoryId(memoryId: string): boolean {
  return isSyntheticMemoryId(memoryId) && !isLocalReviewMemoryId(memoryId);
}

async function resolveMemoryRequest(
  req: NextRequest,
  params: Promise<{ memoryId: string }>,
): Promise<{ memoryId: string; userId: string } | NextResponse> {
  const { memoryId } = await params;

  if (!memoryId) {
    return NextResponse.json({ error: 'memoryId is required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const userId = await resolveSophiaUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  return { memoryId, userId };
}

async function passthroughBackendResponse(backendResponse: Response): Promise<Response> {
  if (backendResponse.status === 204) {
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  const responseText = await backendResponse.text();

  return new NextResponse(responseText, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
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

    if (isBlockedSyntheticMemoryId(memoryId)) {
      return NextResponse.json({ error: 'Synthetic memories cannot be updated' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const body = typeof req.json === 'function'
      ? await req.json().catch(() => null)
      : null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid update payload' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      }
    );

    if (typeof body.idempotency_key === 'string') {
      return canonicalCommandResponse(backendResponse, userId, body.idempotency_key, 'memory_edited', memoryId);
    }
    return passthroughBackendResponse(backendResponse);
  } catch {
    logger.logError(new Error('Memory command unavailable'), { component: 'api/memories/[memoryId]', action: 'update_memory' });
    return NextResponse.json({ error: 'Failed to update memory' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
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

    if (isBlockedSyntheticMemoryId(memoryId)) {
      return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    const body = typeof req.json === 'function'
      ? await req.json().catch(() => null)
      : null;
    if (
      body
      && typeof body === 'object'
      && !Array.isArray(body)
      && ('expected_governance_revision' in body || 'idempotency_key' in body)
    ) {
      return forwardCanonicalLifecycle(userId, memoryId, 'permanent-delete', body);
    }

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'DELETE',
      }
    );

    return passthroughBackendResponse(backendResponse);
  } catch {
    logger.logError(new Error('Memory lifecycle command unavailable'), { component: 'api/memories/[memoryId]', action: 'delete_memory' });
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
