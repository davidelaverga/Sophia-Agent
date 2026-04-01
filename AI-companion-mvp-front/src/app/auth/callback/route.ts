import { NextRequest } from 'next/server'
import { handleDiscordOAuthCallback } from '../../lib/auth/oauth-callback'

export async function GET(request: NextRequest) {
  return handleDiscordOAuthCallback(request)
}
