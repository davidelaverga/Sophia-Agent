import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../../_lib/sophia';

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 12) : null;
}

function correlationId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ parentThreadId: string }> },
) {
  const { parentThreadId } = await params;
  const requestId = correlationId();
  const userId = await resolveSophiaUserId();
  if (!userId) {
    console.warn('[builder-canvas-proxy] snapshot auth failed', {
      route: 'snapshot',
      correlation_id: requestId,
      parent_thread_id: shortId(parentThreadId),
      auth_present: false,
    });
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  console.log('[builder-canvas-proxy] snapshot forwarding', {
    route: 'snapshot',
    correlation_id: requestId,
    parent_thread_id: shortId(parentThreadId),
    user_id: shortId(userId),
    auth_present: true,
  });
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/threads/${encodeURIComponent(parentThreadId)}/builder-canvas/snapshot`,
    { method: 'GET', cache: 'no-store' },
  );
  const payload = await response.json().catch(() => ({}));
  console.log('[builder-canvas-proxy] snapshot response', {
    route: 'snapshot',
    correlation_id: requestId,
    parent_thread_id: shortId(parentThreadId),
    upstream_status: response.status,
    content_type: response.headers.get('Content-Type'),
  });
  return NextResponse.json(payload, { status: response.status });
}
