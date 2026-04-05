import { NextRequest, NextResponse } from "next/server"
import { getServerAuthToken } from "../../../lib/auth/server-auth"

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

export async function GET(request: NextRequest) {
  try {
    // Get user_id from query params
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get("user_id")

    if (!userId) {
      return NextResponse.json(
        { error: "user_id is required" },
        { status: 400 }
      )
    }

    // Use user's backend token or fallback
    const token = await getServerAuthToken()

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
