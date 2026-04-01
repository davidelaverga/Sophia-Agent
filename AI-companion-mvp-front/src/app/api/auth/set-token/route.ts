/**
 * Set Backend Token Endpoint
 * ===========================
 * 
 * POST /api/auth/set-token
 * Body: { token: string }
 * 
 * Sets the backend token as an httpOnly cookie.
 * Used by useBackendTokenSync when the callback flow didn't set the token
 * (e.g., backend was down during auth callback).
 * 
 * Security: Must only be called from the client after a successful
 * syncBackendToken() call — token is already validated by that flow.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const token = body?.token;

    if (!token || typeof token !== 'string' || token.length < 10) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
    }

    const cookieStore = cookies();
    cookieStore.set('sophia-backend-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
