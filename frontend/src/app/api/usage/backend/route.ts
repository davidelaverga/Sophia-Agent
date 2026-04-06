/**
 * Usage Proxy API Route
 * =======================
 * 
 * GET /api/usage/backend
 * 
 * Proxies usage check to backend: GET /api/v1/chat/usage
 * Reads auth from httpOnly cookie (server-side).
 */

import { NextResponse } from 'next/server';

import { getServerAuthHeader, getServerAuthToken } from '../../../lib/auth/server-auth';
import { logger } from '../../../lib/error-logger';

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function GET() {
  const token = await getServerAuthToken();

  if (!token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/usage`, {
      headers: {
        'Authorization': await getServerAuthHeader(),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Backend error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    logger.logError(error, { component: 'api/usage/backend', action: 'check_usage' });
    return NextResponse.json({ error: 'Failed to check usage' }, { status: 502 });
  }
}
