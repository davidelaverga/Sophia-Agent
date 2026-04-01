import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

async function handleConsentCheck(request: NextRequest) {
  try {
    // Verify environment variables
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ hasConsent: false, error: 'Server configuration error' }, { status: 500 })
    }

    // Get Bearer token from Authorization header
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ hasConsent: false }, { status: 401 })
    }
    const accessToken = authHeader.replace('Bearer ', '')

    // Create Supabase client with user's access token
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      }
    )

    // Get current user using the provided token
    const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken)
    
    if (userError || !user) {
      return NextResponse.json({ hasConsent: false }, { status: 401 })
    }

    // Get user's Discord ID from auth metadata
    const discordId = user.user_metadata?.provider_id || user.user_metadata?.sub

    if (!discordId) {
      return NextResponse.json({ hasConsent: false })
    }

    // Ensure discord_id is always a string
    const discordIdString = String(discordId)

    // Create service role client for database operations
    const serviceSupabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Check consent status
    const { data: consent, error: consentError } = await serviceSupabase
      .from('user_consents')
      .select('*')
      .eq('discord_id', discordIdString)
      .single()

    if (consentError) {
      if (consentError.code === 'PGRST116') {
        // Not found - user has no consent record
        return NextResponse.json({ 
          hasConsent: false,
          consentDate: null
        })
      }
      if (consentError.code === 'PGRST205') {
        // Table missing - skip enforcement in this environment
        return NextResponse.json({
          hasConsent: true,
          consentDate: null,
        })
      }
      return NextResponse.json({ 
        hasConsent: false, 
        error: 'Database error'
      }, { status: 500 })
    }

    return NextResponse.json({ 
      hasConsent: !!consent,
      consentDate: consent?.created_at || null
    })

  } catch (_error) {
    return NextResponse.json({ 
      hasConsent: false,
      error: 'Internal server error' 
    }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleConsentCheck(request)
}

export async function POST(request: NextRequest) {
  return handleConsentCheck(request)
}
