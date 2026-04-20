import { type NextRequest, NextResponse } from 'next/server';

import { getAuthenticatedUserId, getUserScopedAuthToken } from '../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  if (!taskId) {
    return NextResponse.json({ error: 'Task ID is required' }, { status: 400 });
  }

  const [userId, apiKey] = await Promise.all([
    getAuthenticatedUserId(),
    getUserScopedAuthToken(),
  ]);

  if (!userId || !apiKey) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/sophia/${userId}/tasks/${taskId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
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