import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../lib/error-logger';
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
    const responseText = await backendResponse.text();
    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    logger.logError(error, { component: 'api/memories', action: 'create_memory', request: req });
    return NextResponse.json({ error: 'Failed to create memory' }, { status: 500 });
  }
}
