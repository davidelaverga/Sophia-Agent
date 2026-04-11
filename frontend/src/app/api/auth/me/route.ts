/**
 * Auth Check Endpoint
 * ====================
 * 
 * GET /api/auth/me
 * 
 * Returns auth status by reading the httpOnly cookie server-side.
 * Clients use this instead of reading document.cookie directly.
 * 
 * 🔒 SECURITY: The raw token is NEVER returned to the client.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { getSession } from '@/server/better-auth';

const COOKIE_NAME = 'sophia-backend-token';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const hasBackendToken = !!cookieStore.get(COOKIE_NAME)?.value;

    // Check Better Auth session for user info
    let userId: string | null = null;
    let email: string | null = null;
    let username: string | null = null;

    try {
      const session = await getSession();
      if (session?.user) {
        userId = session.user.id;
        email = session.user.email ?? null;
        username = session.user.name ?? null;
      }
    } catch {
      // Auth may fail — still report backend token status
    }

    return NextResponse.json({
      authenticated: hasBackendToken,
      user: userId ? { id: userId, email, username } : null,
    });
  } catch {
    return NextResponse.json({ authenticated: false, user: null });
  }
}
