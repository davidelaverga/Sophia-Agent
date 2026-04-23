/**
 * Memory Feedback API Route
 * Bridges POST /api/memory/feedback -> backend /api/sophia/{user_id}/memories
 */

import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, isSyntheticMemoryId, resolveSophiaUserId } from '../../_lib/sophia';

interface MemoryFeedbackRequest {
  action: 'approve' | 'reject';
  memory_text: string;
  category?: string;
  session_id?: string;
  original_memory_id?: string;
  reason?: string;
  user_id?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as MemoryFeedbackRequest;

    if (!body?.memory_text) {
      return NextResponse.json(
        { error: 'memory_text is required' },
        { status: 400 }
      );
    }

    if (body.action !== 'approve' && body.action !== 'reject') {
      return NextResponse.json(
        { error: 'action must be approve or reject' },
        { status: 400 }
      );
    }

    const userId = await resolveSophiaUserId();
    if (!userId) {
      return NextResponse.json(
        { error: 'Unable to resolve user_id' },
        { status: 401 }
      );
    }

    if (body.action === 'reject') {
      if (isSyntheticMemoryId(body.original_memory_id)) {
        return NextResponse.json({ status: 'discarded' });
      }

      const discardMetadata = {
        status: 'discarded',
        ...(body.category ? { category: body.category } : {}),
        ...(body.session_id ? { session_id: body.session_id } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
      };

      const backendResponse = await fetchSophiaApi(
        `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(body.original_memory_id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            metadata: discardMetadata,
          }),
        }
      );

      if (backendResponse.ok) {
        return NextResponse.json({ status: 'discarded' });
      }

      const responseText = await backendResponse.text();

      return new NextResponse(responseText, {
        status: backendResponse.status,
        headers: {
          'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
        },
      });
    }

    const metadata = {
      status: 'approved',
      ...(body.session_id ? { session_id: body.session_id } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.original_memory_id ? { original_memory_id: body.original_memory_id } : {}),
    };

    const backendResponse = !isSyntheticMemoryId(body.original_memory_id)
      ? await fetchSophiaApi(
          `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(body.original_memory_id)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              text: body.memory_text,
              metadata,
            }),
          }
        )
      : await fetchSophiaApi(
          `/api/sophia/${encodeURIComponent(userId)}/memories`,
          {
            method: 'POST',
            body: JSON.stringify({
              text: body.memory_text,
              ...(body.category ? { category: body.category } : {}),
              metadata,
            }),
          }
        );

    const responseText = await backendResponse.text();

    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    logger.logError(error, { component: 'api/memory/feedback', action: 'submit_feedback' });
    return NextResponse.json(
      { error: 'Failed to submit memory feedback' },
      { status: 500 }
    );
  }
}
