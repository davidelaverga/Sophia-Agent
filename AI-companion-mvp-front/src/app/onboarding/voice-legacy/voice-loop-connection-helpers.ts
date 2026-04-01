/**
 * Voice loop connection helpers — WebSocket session management utilities.
 * Used by onboarding voice flow and the legacy voice loop.
 */

/**
 * Resolve the WebSocket base URL for the voice backend.
 * Falls back to localhost:8000 if environment variables are not set.
 */
export function resolveVoiceWsBaseUrl(): string {
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL
  }
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL
  }
  return "http://localhost:8000"
}

/**
 * Generate a unique voice session ID.
 */
export function generateVoiceSessionId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `voice-${timestamp}-${random}`
}

type ConnectVoiceSessionOptions = {
  disconnect: (code?: number, reason?: string) => void
  connect: (
    baseUrl: string,
    sessionId: string,
    handlers?: Record<string, unknown>,
    token?: string,
  ) => Promise<WebSocket>
  baseUrl: string
  sessionId: string
  handlers?: Record<string, unknown>
  token?: string
  useSingleRetry?: boolean
}

type ConnectVoiceSessionResult = {
  result: WebSocket | null
}

/**
 * Safely connect to a voice WebSocket session.
 * Disconnects any existing session first, then connects fresh.
 * Optionally retries once on failure.
 */
export async function connectVoiceSessionFreshSafely(
  options: ConnectVoiceSessionOptions,
): Promise<ConnectVoiceSessionResult> {
  const { disconnect, connect, baseUrl, sessionId, handlers, token, useSingleRetry } = options

  // Disconnect any existing session
  try {
    disconnect()
  } catch {
    // ignore disconnect errors
  }

  // Small delay to allow cleanup
  await new Promise((resolve) => setTimeout(resolve, 50))

  try {
    const ws = await connect(baseUrl, sessionId, handlers, token)
    return { result: ws }
  } catch (firstError) {
    if (!useSingleRetry) {
      return { result: null }
    }

    // Single retry after a brief delay
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const ws = await connect(baseUrl, sessionId, handlers, token)
      return { result: ws }
    } catch {
      return { result: null }
    }
  }
}