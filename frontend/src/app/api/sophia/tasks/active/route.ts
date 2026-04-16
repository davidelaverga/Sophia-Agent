import { type NextRequest, NextResponse } from 'next/server';

import { getAuthenticatedUserId, getUserScopedAuthToken } from '../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

export async function GET(request: NextRequest) {
  const threadId = request.nextUrl.searchParams.get('thread_id');

  if (!threadId) {
    return NextResponse.json(null);
  }

  const [userId, apiKey] = await Promise.all([
    getAuthenticatedUserId(),
    getUserScopedAuthToken(),
  ]);

  if (!userId || !apiKey) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const params = new URLSearchParams({ thread_id: threadId });
    const response = await fetch(
      `${BACKEND_URL}/api/sophia/${userId}/tasks/active?${params.toString()}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
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
