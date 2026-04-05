/**
 * Logout Endpoint
 * ================
 * 
 * POST /api/auth/logout
 * 
 * Clears the httpOnly `sophia-backend-token` cookie server-side.
 * JS cannot clear httpOnly cookies via `document.cookie`, so
 * sign-out flows must call this endpoint.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST() {
  const cookieStore = cookies();

  // Delete by setting maxAge to 0
  cookieStore.set('sophia-backend-token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return NextResponse.json({ ok: true });
}
