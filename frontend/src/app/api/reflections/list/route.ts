import { type NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUserId, getUserScopedAuthToken } from "../../../lib/auth/server-auth";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit") || "20";
  const userId = await getAuthenticatedUserId();

  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const apiKey = await getUserScopedAuthToken();
  if (!apiKey) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    // Call backend GET /api/reflections/latest
    const response = await fetch(
      `${BACKEND_URL}/api/reflections/latest?user_id=${encodeURIComponent(userId)}&limit=${limit}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      // Return empty array on error
      return NextResponse.json({ reflections: [] });
    }

    const data = await response.json();
    
    // Transform backend response to match frontend expectations
    // Backend returns array directly, we wrap it
    const reflections = Array.isArray(data) ? data : data.reflections || [];
    
    return NextResponse.json({ 
      reflections: reflections.map((r: {
        id: string;
        summary?: string;
        title?: string;
        created_at: string;
        shared?: boolean;
        likes?: number;
        tags?: string[];
      }) => ({
        id: r.id,
        text: r.summary || r.title || "",
        reason: r.tags?.[0] || "reflection",
        created_at: r.created_at,
        shared: r.shared || false,
        likes: r.likes || 0,
      }))
    });
  } catch {
    return NextResponse.json({ reflections: [] });
  }
}
