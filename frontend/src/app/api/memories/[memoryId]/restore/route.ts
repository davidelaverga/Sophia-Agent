import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../../lib/error-logger';
import { fetchSophiaApi, resolveSophiaUserId } from '../../../_lib/sophia';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ memoryId: string }> },
) {
  try {
    const { memoryId } = await params;
    const userId = await resolveSophiaUserId();
    if (!memoryId || !userId) {
      return NextResponse.json({ error: 'Unable to resolve memory owner' }, { status: 401 });
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid restore payload' }, { status: 400 });
    }
    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}/restore`,
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
    logger.logError(error, { component: 'api/memories/[memoryId]/restore', action: 'restore_memory', request: req });
    return NextResponse.json({ error: 'Failed to restore memory' }, { status: 500 });
  }
}
