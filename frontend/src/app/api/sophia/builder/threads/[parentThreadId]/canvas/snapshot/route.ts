import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../../_lib/sophia';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ parentThreadId: string }> },
) {
  const { parentThreadId } = await params;
  const userId = await resolveSophiaUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/threads/${encodeURIComponent(parentThreadId)}/builder-canvas/snapshot`,
    { method: 'GET', cache: 'no-store' },
  );
  const payload = await response.json().catch(() => ({}));
  return NextResponse.json(payload, { status: response.status });
}
