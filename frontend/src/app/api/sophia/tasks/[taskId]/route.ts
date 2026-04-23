import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../_lib/sophia';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  if (!taskId) {
    return NextResponse.json({ error: 'Task ID is required' }, { status: 400 });
  }

  const userId = await resolveSophiaUserId();

  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const response = await fetchSophiaApi(`/api/sophia/${encodeURIComponent(userId)}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      cache: 'no-store',
    });

    const payload = await response.json().catch(() => ({}));
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      {
        task_id: taskId,
        status: 'unavailable',
        detail: 'Builder status request could not reach the backend.',
      },
      { status: 503 },
    );
  }
}