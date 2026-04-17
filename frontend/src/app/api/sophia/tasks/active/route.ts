import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../_lib/sophia';

export async function GET(request: NextRequest) {
  const threadId = request.nextUrl.searchParams.get('thread_id');

  if (!threadId) {
    return NextResponse.json(null);
  }

  const userId = await resolveSophiaUserId();

  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const params = new URLSearchParams({ thread_id: threadId });
    const response = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/tasks/active?${params.toString()}`,
      {
        method: 'GET',
        cache: 'no-store',
      },
    );

    if (!response.ok || response.status === 204) {
      return NextResponse.json(null);
    }

    const payload = await response.json().catch(() => null);
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json(null);
  }
}
