import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../../../lib/error-logger';
import { memoryReviewEnvelopeSchema } from '../../../../../lib/memory-review-envelope';
import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const noStore = { 'Cache-Control': 'no-store' };
    const { sessionId } = await params;
    const userId = await resolveSophiaUserId();

    if (!userId) {
      return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401, headers: noStore });
    }

    const query = new URLSearchParams();
    for (const name of ['cursor', 'page_size']) {
      const value = request.nextUrl.searchParams.get(name);
      if (value !== null) query.set(name, value);
    }
    const suffix = query.size ? `?${query.toString()}` : '';
    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/recap${suffix}`,
      {
        method: 'GET',
        cache: 'no-store',
      },
    );

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      return NextResponse.json({ error: 'Recap unavailable' }, { status: backendResponse.status, headers: noStore });
    }
    const body = JSON.parse(responseText) as Record<string, unknown>;
    if (body.memory_review != null) {
      const envelope = memoryReviewEnvelopeSchema.parse(body.memory_review);
      if (envelope.owner_id !== userId || envelope.session_id !== sessionId) throw new Error('Review owner mismatch');
      return NextResponse.json({ session_id: sessionId, thread_id: envelope.thread_id, status: envelope.extraction_state,
        ended_at: envelope.finalization.ended_at, memory_review: envelope }, { headers: noStore });
    }

    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
        ...noStore,
      },
    });
  } catch {
    logger.logError(new Error('Recap unavailable'), { component: 'api/sophia/sessions/[sessionId]/recap', action: 'get_recap' });
    return NextResponse.json({ error: 'Failed to load Sophia recap' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
