import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../lib/error-logger';
import { canonicalCommandResponse } from '../_lib/memory-command-response';
import { fetchSophiaApi, resolveSophiaUserId } from '../_lib/sophia';

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveSophiaUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid memory payload' }, { status: 400 });
    }

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (typeof body.idempotency_key === 'string') {
      return canonicalCommandResponse(backendResponse, userId, body.idempotency_key, 'memory_manual_created');
    }
    const responseText = await backendResponse.text();
    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    logger.logError(new Error('Memory command unavailable'), { component: 'api/memories', action: 'create_memory' });
    return NextResponse.json({ error: 'Failed to create memory' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
