import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/server/better-auth'

async function handleConsentCheck() {
  try {
    // Authenticate user via Better Auth session
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) {
      return NextResponse.json({ hasConsent: false }, { status: 401 })
    }

    // TODO: Move consent storage to the backend API.
    // Consent checking is temporarily stubbed here until backend persistence lands.
    // For now, return true to unblock the client flow.

    return NextResponse.json({ 
      hasConsent: true,
      consentDate: null
    })

  } catch (_error) {
    return NextResponse.json({ 
      hasConsent: false,
      error: 'Internal server error' 
    }, { status: 500 })
  }
}

export async function GET(_request: NextRequest) {
  return handleConsentCheck()
}

export async function POST(_request: NextRequest) {
  return handleConsentCheck()
}
