/**
 * WebSocket Ticket Endpoint
 * ==========================
 * 
 * POST /api/ws-ticket
 * 
 * Returns the backend token so the client can pass it as a WS query param.
 * 
 * WebSocket connections cannot use httpOnly cookies (cross-origin or not),
 * so we expose a short endpoint that reads the httpOnly cookie server-side
 * and returns the token for use in a single WS connection.
 * 
 * Security notes:
 * - Token is only returned if the httpOnly cookie is valid
 * - Client should use this immediately and not persist
 * - This is the accepted pattern for WS auth with httpOnly cookies
 */

import { NextResponse } from 'next/server';
import { getServerAuthToken } from '../../lib/auth/server-auth';
import { apiLimiters } from '../../lib/rate-limiter';
import { logger } from '../../lib/error-logger';

export async function POST() {
  if (!apiLimiters.wsTicket.checkSync()) {
    const waitMs = apiLimiters.wsTicket.getState().waitTime;
    logger.warn('WS ticket rate limited', {
      component: 'api/ws-ticket',
      action: 'rate_limit',
      metadata: { waitMs },
    });

    return NextResponse.json(
      { error: 'Too many ws-ticket requests' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))),
        },
      }
    );
  }

  const token = await getServerAuthToken();

  if (!token) {
    logger.warn('WS ticket auth missing', {
      component: 'api/ws-ticket',
      action: 'auth_missing',
    });
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  return NextResponse.json(
    { token },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
