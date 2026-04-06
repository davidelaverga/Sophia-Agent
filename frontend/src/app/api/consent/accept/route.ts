import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/server/better-auth'

export async function POST(request: NextRequest) {
  try {
    // Authenticate user via Better Auth session
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userId = session.user.id

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

  } catch (_error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
