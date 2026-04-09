/**
 * Auth Module - Public Exports
 * =============================
 * 
 * This module provides authentication with the Sophia backend.
 * 
 * Client-side usage:
 * ```tsx
 * import { useBackendAuth, getBackendToken } from '../lib/auth'
 * 
 * function MyComponent() {
 *   const { token, isAuthenticated } = useBackendAuth()
 *   // ...
 * }
 * ```
 * 
 * Server-side usage (API routes):
 * ```tsx
 * import { getServerAuthToken } from '../lib/auth/server-auth'
 * 
 * export async function GET() {
 *   const token = getServerAuthToken()
 *   // ...
 * }
 * ```
 */

// Client-side exports
export {
  providerLogin,
  discordLogin,
  registerWithBackend,
  validateToken,
  getCurrentUser,
  refreshToken,
  type ProviderLoginRequest,
  type DiscordLoginRequest,
  type BackendRegisterRequest,
  type BackendUserResponse,
  type BackendValidateResponse,
} from './backend-auth'

// Re-export hook for convenience (must be imported separately due to "use client")
// import { useBackendAuth, getBackendToken } from '../hooks/useBackendAuth'
