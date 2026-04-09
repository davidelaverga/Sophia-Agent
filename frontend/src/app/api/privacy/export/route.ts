/**
 * Privacy Export Route - V4 Backend Adaptation
 * ==============================================
 * 
 * Uses V4 backend's Mem0 endpoint: GET /mem0/{user_id}/memories
 * 
 * Exports user's memories as a JSON file for GDPR compliance.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUserId, getUserScopedAuthToken } from "../../../lib/auth/server-auth";

export async function GET(_request: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL;

  if (!backendUrl) {
    return NextResponse.json(
      { error: "Server configuration incomplete" },
      { status: 500 }
    );
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const apiKey = await getUserScopedAuthToken();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    // Fetch user's memories from Mem0 (V4 backend endpoint)
    const mem0Response = await fetch(
      `${backendUrl}/mem0/${userId}/memories`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      }
    );

    let memories: unknown[] = [];
    if (mem0Response.ok) {
      const data = await mem0Response.json();
      memories = data.memories || [];
    }

    // Create export data structure
    const exportData = {
      export_date: new Date().toISOString(),
      user_id: userId,
      data: {
        memories,
        conversations: [], // Would need separate endpoint
        preferences: {}, // Would need separate endpoint
      },
      metadata: {
        format_version: "2.0",
        backend_version: "v4",
      },
    };

    const blob = new Blob(
      [JSON.stringify(exportData, null, 2)],
      { type: "application/json" }
    );

    return new NextResponse(blob, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename=sophia-data-${userId.slice(0, 8)}.json`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to export data" },
      { status: 500 }
    );
  }
}

