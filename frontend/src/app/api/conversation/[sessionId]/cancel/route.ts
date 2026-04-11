import { type NextRequest, NextResponse } from "next/server"

import { getUserScopedAuthToken } from "../../../../lib/auth/server-auth"

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

/**
 * POST /api/conversation/[sessionId]/cancel
 * 
 * Proxies cancellation request to backend's /api/v1/chat/cancel/{session_id}
 * This tells the backend to stop processing the current stream.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params

  if (!sessionId) {
    return NextResponse.json(
      { error: "Session ID is required" },
      { status: 400 }
    )
  }

  const apiKey = await getUserScopedAuthToken()
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  }

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/chat/cancel/${sessionId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
      }
    )

    if (!response.ok) {
      // Backend might return 404 if session doesn't exist - that's okay
      if (response.status === 404) {
        return NextResponse.json(
          { status: "session_not_found", session_id: sessionId },
          { status: 200 } // Return 200 - cancellation is still "successful" from user perspective
        )
      }
      
      const errorData = await response.json().catch(() => ({}))
      return NextResponse.json(
        { error: "Failed to cancel", details: errorData },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch {
    // Return success anyway - the AbortController already stopped the frontend
    return NextResponse.json(
      { status: "cancel_attempted", session_id: sessionId },
      { status: 200 }
    )
  }
}
