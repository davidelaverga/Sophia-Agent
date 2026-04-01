/**
 * Backend Authentication Client
 * ==============================
 * 
 * Handles authentication with the AI-companion-mvp backend.
 * After Discord OAuth via Supabase, we register the user with
 * the backend to get a per-user api_token.
 * 
 * Flow:
 * 1. User completes Discord OAuth via Supabase
 * 2. Frontend calls loginOrRegister() with Discord data
 * 3. Backend returns api_token (creates user if new, returns existing if not)
 * 4. Token is stored and used for all subsequent API calls
 */

// ============================================================================
// TYPES
// ============================================================================

export interface BackendRegisterRequest {
  email: string
  username?: string
  discord_id?: string
}

export interface DiscordLoginRequest {
  discord_id: string
  email: string
  username?: string
  discriminator?: string
  avatar?: string
}

export interface BackendUserResponse {
  id: string
  email: string
  username: string | null
  discord_id: string | null
  is_active: boolean
  api_token: string
  has_consent?: boolean
  plan_tier?: string
  created_at?: string
  updated_at?: string
}

export interface BackendValidateResponse {
  valid: boolean
  user_id?: string
  email?: string
  is_active?: boolean
  message?: string
}

export interface BackendAuthError {
  detail: string
  code?: string
}

// ============================================================================
// CONFIGURATION
// ============================================================================

function getBackendUrl(): string {
  // Server-side: use internal URL if available
  const serverUrl = process.env.BACKEND_API_URL
  // Client-side: use public URL
  const publicUrl = process.env.NEXT_PUBLIC_API_URL
  
  const url = serverUrl || publicUrl || 'http://localhost:8000'
  return url.replace(/\/$/, '') // Remove trailing slash
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Login or register a user with Discord credentials.
 * Uses the /api/v1/auth/discord/login endpoint which handles both:
 * - Existing users: Returns existing user with token
 * - New users: Creates user and returns with token
 * 
 * @param data User data from Discord OAuth
 * @returns BackendUserResponse with api_token
 */
export async function discordLogin(
  data: DiscordLoginRequest
): Promise<BackendUserResponse> {
  const url = `${getBackendUrl()}/api/v1/auth/discord/login`
  
  try {
    // Add timeout to prevent hanging forever
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)
    
    if (!response.ok) {
      const error: BackendAuthError = await response.json().catch(() => ({
        detail: `HTTP ${response.status}: ${response.statusText}`,
      }))
      throw new Error(error.detail || 'Failed to login with backend')
    }
    
    const user: BackendUserResponse = await response.json()
    
    return user
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error('Backend request timed out')
      }
      throw error
    }
    throw new Error('Network error during Discord login')
  }
}

/**
 * Register a user with the backend (legacy, use discordLogin instead).
 * Kept for backwards compatibility.
 * 
 * @param data User data from Discord OAuth
 * @returns BackendUserResponse with api_token, or null if user exists
 * @deprecated Use discordLogin instead
 */
export async function registerWithBackend(
  data: BackendRegisterRequest
): Promise<BackendUserResponse | null> {
  // If we have discord_id, use the discord/login endpoint instead
  if (data.discord_id) {
    try {
      return await discordLogin({
        discord_id: data.discord_id,
        email: data.email,
        username: data.username,
      })
    } catch {
      // Fall back to register
    }
  }
  
  const url = `${getBackendUrl()}/api/v1/auth/register`
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })
    
    // User already exists - this is okay for login flow
    if (response.status === 409) {
      return null
    }
    
    if (!response.ok) {
      const error: BackendAuthError = await response.json().catch(() => ({
        detail: `HTTP ${response.status}: ${response.statusText}`,
      }))
      throw new Error(error.detail || 'Failed to register with backend')
    }
    
    const user: BackendUserResponse = await response.json()
    
    return user
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error('Network error during backend registration')
  }
}

/**
 * Login or register - handles both new and existing users.
 * 
 * Flow:
 * 1. Try to register
 * 2. If 409 (exists), check for existing token in cookie
 * 3. If no token, we can't authenticate (user needs to contact support)
 * 
 * @param data User data from Discord OAuth
 * @param existingToken Optional existing token to validate
 * @returns User response with token, or throws
 */
export async function loginOrRegister(
  data: BackendRegisterRequest,
  existingToken?: string | null
): Promise<BackendUserResponse> {
  // First, try to register
  const newUser = await registerWithBackend(data)
  
  if (newUser) {
    // New user created successfully
    return newUser
  }
  
  // User exists - validate existing token if we have one
  if (existingToken) {
    try {
      const validation = await validateToken(existingToken)
      if (validation.valid && validation.user_id) {
        // Token is still valid, get full user info
        const user = await getCurrentUser(existingToken)
        return {
          ...user,
          api_token: existingToken,
        }
      }
    } catch {
      // Token validation failed
    }
  }
  
  // User exists but no valid token - this is a problem
  // The user needs to have their token regenerated by backend
  // For now, we'll throw an error that the UI can handle gracefully
  throw new Error('EXISTING_USER_NO_TOKEN')
}

/**
 * Validate an existing api_token with the backend.
 * 
 * @param token The api_token to validate
 * @returns BackendValidateResponse if valid
 * @throws Error if token is invalid or expired
 */
export async function validateToken(
  token: string
): Promise<BackendValidateResponse> {
  const url = `${getBackendUrl()}/api/v1/auth/validate`
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    })
    
    if (!response.ok) {
      throw new Error('Token validation failed')
    }
    
    return await response.json()
  } catch {
    throw new Error('Token validation failed')
  }
}

/**
 * Get current user info using the api_token.
 * 
 * @param token The api_token
 * @returns User info
 */
export async function getCurrentUser(
  token: string
): Promise<BackendUserResponse> {
  const url = `${getBackendUrl()}/api/v1/auth/me`
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  })
  
  if (!response.ok) {
    throw new Error('Failed to get current user')
  }
  
  return await response.json()
}

/**
 * Refresh an api_token.
 * 
 * @param token The current api_token
 * @returns New BackendUserResponse with fresh token
 */
export async function refreshToken(
  token: string
): Promise<BackendUserResponse> {
  const url = `${getBackendUrl()}/api/v1/auth/token/refresh`
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirm: true }),
  })
  
  if (!response.ok) {
    throw new Error('Failed to refresh token')
  }
  
  return await response.json()
}

/**
 * Sync backend token from Supabase user data.
 * Call this when user has Supabase session but no backend token.
 * 
 * @param supabaseUser User data from Supabase session
 * @returns BackendUserResponse with api_token, or null if sync failed
 */
export async function syncBackendToken(
  supabaseUser: {
    id: string
    email?: string | null
    user_metadata?: Record<string, unknown>
  }
): Promise<BackendUserResponse | null> {
  try {
    const metadata = supabaseUser.user_metadata || {}
    
    // Extract Discord ID from various possible locations
    const discordId =
      metadata.provider_id ||
      metadata.sub ||
      metadata.provider_token ||
      metadata.user_id ||
      null
    
    if (!discordId) {
      return null
    }
    
    // Extract username
    const username = (
      metadata.full_name ||
      metadata.name ||
      metadata.preferred_username ||
      null
    ) as string | null
    
    const backendUser = await discordLogin({
      discord_id: String(discordId),
      email: supabaseUser.email || `${supabaseUser.id}@placeholder.sophia`,
      username: username || undefined,
    })
    
    if (backendUser?.api_token) {
      return backendUser
    }
    
    return null
  } catch {
    return null
  }
}
