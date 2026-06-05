import { type NextRequest } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../../_lib/sophia';

export const dynamic = 'force-dynamic';

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 12) : null;
}

function correlationId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ parentThreadId: string }> },
) {
  const { parentThreadId } = await params;
  const requestId = correlationId();
  const userId = await resolveSophiaUserId();
  if (!userId) {
    console.warn('[builder-canvas-proxy] events auth failed', {
      route: 'events',
      correlation_id: requestId,
      parent_thread_id: shortId(parentThreadId),
      auth_present: false,
    });
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
  }
  const lastEventId = request.headers.get('last-event-id');
  console.log('[builder-canvas-proxy] events forwarding', {
    route: 'events',
    correlation_id: requestId,
    parent_thread_id: shortId(parentThreadId),
    user_id: shortId(userId),
    auth_present: true,
    last_event_id: shortId(lastEventId),
  });
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/threads/${encodeURIComponent(parentThreadId)}/builder-canvas/events`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
    },
  );
  console.log('[builder-canvas-proxy] events response', {
    route: 'events',
    correlation_id: requestId,
    parent_thread_id: shortId(parentThreadId),
    upstream_status: response.status,
    content_type: response.headers.get('Content-Type'),
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
