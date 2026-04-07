import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';
import { logger } from '../../../../../lib/error-logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    const userId = await resolveSophiaUserId(request.nextUrl.searchParams.get('user_id'));

    if (!userId) {
      return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401 });
    }

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/recap`,
      {
        method: 'GET',
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
    logger.logError(error, { component: 'api/sophia/sessions/[sessionId]/recap', action: 'get_recap' });
    return NextResponse.json({ error: 'Failed to load Sophia recap' }, { status: 500 });
  }
}