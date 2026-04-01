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

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';

const COOKIE_NAME = 'sophia-backend-token';

export async function GET() {
  try {
    const cookieStore = cookies();
    const hasBackendToken = !!cookieStore.get(COOKIE_NAME)?.value;

    // Also check Supabase session for user info
    let userId: string | null = null;
    let email: string | null = null;
    let username: string | null = null;

    try {
      const supabase = createRouteHandlerClient({ cookies: () => cookieStore });
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        userId = user.id;
        email = user.email ?? null;
        username = user.user_metadata?.username ?? null;
      }
    } catch {
      // Supabase auth may fail — still report backend token status
    }

    return NextResponse.json({
      authenticated: hasBackendToken,
      user: userId ? { id: userId, email, username } : null,
    });
  } catch {
    return NextResponse.json({ authenticated: false, user: null });
  }
}
