import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

export async function POST(request: NextRequest) {
  try {
    // Verify environment variables are set
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    // Get Bearer token from Authorization header
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized - missing token' }, { status: 401 })
    }
    const accessToken = authHeader.replace('Bearer ', '')

    // Create Supabase client with the user's access token
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
    
    if (userError) {
      return NextResponse.json({ error: 'Unauthorized - authentication error' }, { status: 401 })
    }
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized - no user' }, { status: 401 })
    }

    // Get user's Discord ID from auth metadata
    const discordId = user.user_metadata?.provider_id || 
                     user.user_metadata?.sub || 
                     user.user_metadata?.provider_token ||
                     user.id

    if (!discordId) {
      return NextResponse.json({ error: 'Discord ID not found' }, { status: 404 })
    }

    // Ensure discord_id is always a string
    const discordIdString = String(discordId)

    // Get client IP
    const forwarded = request.headers.get('x-forwarded-for')
    const ip = forwarded ? forwarded.split(',')[0] : request.headers.get('x-real-ip') || 'unknown'

    const body = await request.json()
    const { timestamp } = body

    // Validate timestamp
    if (!timestamp) {
      return NextResponse.json({ error: 'Timestamp is required' }, { status: 400 })
    }

    // Create consent hash
    const consentData = `${discordIdString}:${timestamp}:${ip}`
    const consentHash = createHash('sha256').update(consentData).digest('hex')

    // Create service role client for database operations
    const serviceSupabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Find user in users table by discord_id
    const { data: existingUser, error: userLookupError } = await serviceSupabase
      .from('users')
      .select('id, discord_id')
      .eq('discord_id', discordIdString)
      .single()

    if (userLookupError && userLookupError.code !== 'PGRST116') {
      // Log only in development
    }

    // Check if consent already exists
    const { data: existingConsent, error: checkError } = await serviceSupabase
      .from('user_consents')
      .select('discord_id')
      .eq('discord_id', discordIdString)
      .single()

    if (checkError && checkError.code !== 'PGRST116') {
      if (checkError.code === 'PGRST205') {
        return NextResponse.json({
          success: true,
          message: 'Consent recorded (table missing; skipped persistence)'
        })
      }
    }

    if (existingConsent) {
      return NextResponse.json({ 
        success: true,
        message: 'Consent already exists'
      })
    }

    // Get the user's ID from the users table
    let usersTableId: string | null = null
    
    if (existingUser) {
      usersTableId = existingUser.id
    } else {
      return NextResponse.json({ 
        error: 'User not found. Please try logging in again.',
      }, { status: 400 })
    }

    // Build consent record
    const consentRecord: Record<string, string> = {
      user_id: usersTableId!,
      discord_id: discordIdString,
      consent_hash: consentHash,
      ip_address: ip,
    }

    // Insert consent record
    const { error: insertError } = await serviceSupabase
      .from('user_consents')
      .insert(consentRecord)
      .select()

    if (insertError) {
      // Handle duplicate key error gracefully
      if (insertError.code === '23505') {
        return NextResponse.json({ 
          success: true,
          message: 'Consent already exists'
        })
      }
      if (insertError.code === 'PGRST205') {
        return NextResponse.json({
          success: true,
          message: 'Consent recorded (table missing; skipped persistence)'
        })
      }
      
      return NextResponse.json({ 
        error: 'Failed to store consent',
      }, { status: 500 })
    }

    return NextResponse.json({ 
      success: true,
      message: 'Consent recorded successfully'
    })

  } catch (_error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
