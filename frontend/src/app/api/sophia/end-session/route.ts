import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';
import { logger } from '../../../lib/error-logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const userId = await resolveSophiaUserId(typeof body.user_id === 'string' ? body.user_id : null);

    if (!userId) {
      return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401 });
    }

    const { user_id: _ignoredUserId, ...payload } = body;
    const normalizedPayload = {
      ...payload,
      thread_id: typeof payload.thread_id === 'string' && payload.thread_id.trim().length > 0
        ? payload.thread_id
        : payload.session_id,
    };
    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/end-session`,
      {
        method: 'POST',
        body: JSON.stringify(normalizedPayload),
      },
    );

    const responseText = await backendResponse.text();

    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    logger.logError(error, { component: 'api/sophia/end-session', action: 'end_session' });
    return NextResponse.json({ error: 'Failed to end Sophia session' }, { status: 500 });
  }
}