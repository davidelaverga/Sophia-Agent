import { type NextRequest, NextResponse } from 'next/server'

/**
 * Legacy auth callback route.
 * Better Auth handles callbacks via /api/auth/callback/:provider.
 * This route redirects stale bookmarks to the home page.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  return NextResponse.redirect(new URL('/', url.origin))
}
