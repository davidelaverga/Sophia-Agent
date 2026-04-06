import { type NextRequest, NextResponse } from 'next/server'

import { getServerAuthHeader, getServerAuthToken } from '../../../lib/auth/server-auth'

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export async function GET(_request: NextRequest) {
  const token = await getServerAuthToken()

  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/usage`, {
      headers: {
        Authorization: await getServerAuthHeader(),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      return NextResponse.json({ error: `Backend error: ${response.status}` }, { status: response.status })
    }

    const data = await response.json()

    return NextResponse.json({
      voice_seconds_used: data?.today?.voice_seconds || 0,
      text_seconds_used: data?.today?.text_tokens || 0,
      reflections_count: 0,
      usage: data,
      deprecated: true,
      official_endpoint: '/api/usage/backend',
    }, {
      headers: {
        'Deprecation': 'true',
        'Sunset': 'Tue, 31 Mar 2026 23:59:59 GMT',
        'Link': '</api/usage/backend>; rel="successor-version"',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

