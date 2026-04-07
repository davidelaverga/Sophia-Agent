import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, isSyntheticMemoryId, resolveSophiaUserId } from '../../_lib/sophia';
import { logger } from '../../../lib/error-logger';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ memoryId: string }> }
) {
  try {
    const { memoryId } = await params;

    if (!memoryId) {
      return NextResponse.json({ error: 'memoryId is required' }, { status: 400 });
    }

    if (isSyntheticMemoryId(memoryId)) {
      return new NextResponse(null, { status: 204 });
    }

    const userId = await resolveSophiaUserId(req.nextUrl.searchParams.get('user_id'));
    if (!userId) {
      return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401 });
    }

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'DELETE',
      }
    );

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
  } catch (error) {
    logger.logError(error, { component: 'api/memories/[memoryId]', action: 'delete_memory' });
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 500 });
  }
}
