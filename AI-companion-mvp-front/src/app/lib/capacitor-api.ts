import { Capacitor } from '@capacitor/core'

/**
 * API URL resolver for hybrid web/native apps
 * 
 * On web, API calls go to Next.js API routes (e.g., /api/conversation/feedback)
 * On native (Capacitor), API calls go directly to the backend server
 */

// Backend URL from environment
const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'https://sophia-backend-g8fe.onrender.com'

/**
 * Check if we're running in a native Capacitor environment
 */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/**
 * Map Next.js API routes to backend endpoints
 * 
 * Next.js API Route -> Backend Endpoint
 */
const API_ROUTE_MAP: Record<string, string> = {
  '/api/conversation/feedback': '/api/v1/conversation/feedback',
  '/api/community/latest-learning': '/api/community/latest-learning',
  '/api/community/user-impact': '/api/community/user-impact',
  '/api/reflections/prompt': '/api/reflections/prompt',
  '/api/reflections/run': '/api/reflections/run',
  '/api/privacy/status': '/api/privacy/status',
  '/api/privacy/export': '/api/privacy/export',
  '/api/privacy/delete': '/api/privacy/delete',
  '/api/privacy/consent': '/api/privacy/consent',
  '/api/consent/check': '/api/consent/check',
  '/api/consent/accept': '/api/consent/accept',
  '/api/usage/check': '/api/v1/chat/usage',
}

/**
 * Resolve the correct API URL based on platform
 * 
 * @param path - The API path (e.g., '/api/conversation/feedback')
 * @returns The resolved URL (relative on web, absolute on native)
 */
export function resolveApiUrl(path: string): string {
  // On web, use relative paths (Next.js API routes)
  if (!isNativePlatform()) {
    return path
  }
  
  // On native, resolve to backend URL
  // Check if this is a known mapped route
  const mappedPath = API_ROUTE_MAP[path]
  if (mappedPath) {
    return `${BACKEND_URL}${mappedPath}`
  }
  
  // Handle dynamic routes (e.g., /api/conversation/[sessionId]/cancel)
  const dynamicRouteMatch = path.match(/^\/api\/conversation\/([^/]+)\/cancel$/)
  if (dynamicRouteMatch) {
    return `${BACKEND_URL}/api/v1/chat/cancel/${dynamicRouteMatch[1]}`
  }
  
  // Default: append path to backend URL
  return `${BACKEND_URL}${path}`
}

/**
 * Get the backend URL for WebSocket connections
 */
export function getWebSocketUrl(): string {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_BACKEND_WS_URL
  if (wsUrl) return wsUrl
  
  // Convert http(s) URL to ws(s) URL
  return BACKEND_URL.replace(/^http/, 'ws')
}

/**
 * Get the backend URL for direct API calls
 */
export function getBackendUrl(): string {
  return BACKEND_URL
}
