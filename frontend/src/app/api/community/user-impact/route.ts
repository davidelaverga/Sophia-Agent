import { NextResponse } from "next/server"

import { getAuthenticatedUserId, getUserScopedAuthToken } from "../../../lib/auth/server-auth"

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()

    if (!userId) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      )
    }

    const token = await getUserScopedAuthToken()
    if (!token) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      )
    }

    const response = await fetch(
      `${BACKEND_URL}/api/community/user-impact?user_id=${encodeURIComponent(userId)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        cache: "no-store",
      }
    )

    if (!response.ok) {
      // Return empty stats on error
      return NextResponse.json({
        user_id: userId,
        session_count: 0,
        reflections_created: 0,
        reflections_shared: 0,
        last_session_at: null,
      })
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({
      user_id: "unknown",
      session_count: 0,
      reflections_created: 0,
      reflections_shared: 0,
      last_session_at: null,
    })
  }
}
