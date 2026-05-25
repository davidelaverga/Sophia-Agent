import { type NextRequest } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../../_lib/sophia';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ parentThreadId: string }> },
) {
  const { parentThreadId } = await params;
  const userId = await resolveSophiaUserId();
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
  }
  const lastEventId = request.headers.get('last-event-id');
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/threads/${encodeURIComponent(parentThreadId)}/builder-canvas/events`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
    },
  );
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
