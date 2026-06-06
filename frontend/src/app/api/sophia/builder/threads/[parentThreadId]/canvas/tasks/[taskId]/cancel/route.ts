import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../../../../_lib/sophia';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ parentThreadId: string; taskId: string }> },
) {
  const { parentThreadId, taskId } = await params;
  const userId = await resolveSophiaUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/threads/${encodeURIComponent(parentThreadId)}/builder-canvas/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: 'POST', cache: 'no-store' },
  );
  const payload = await response.json().catch(() => ({}));
  return NextResponse.json(payload, { status: response.status });
}
