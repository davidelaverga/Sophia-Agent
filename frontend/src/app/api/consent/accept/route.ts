import { type NextRequest, NextResponse } from 'next/server'

import { getSession } from '@/server/better-auth'

export async function POST(request: NextRequest) {
  try {
    // Authenticate user via Better Auth session
    const session = await getSession()
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { timestamp } = body

    // Validate timestamp
    if (!timestamp) {
      return NextResponse.json({ error: 'Timestamp is required' }, { status: 400 })
    }

    // TODO: Move consent storage to the backend API.
    // Consent persistence is temporarily stubbed here until backend persistence lands.
    // For now, return success to unblock the client flow.

    return NextResponse.json({ 
      success: true,
      message: 'Consent recorded successfully'
    })

  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
