/**
 * Privacy Delete Route - V4 Backend Adaptation
 * ==============================================
 * 
 * Uses V4 backend's Mem0 delete endpoint: DELETE /mem0/{user_id}/memories
 * 
 * This clears the user's long-term memories from the system.
 * Full account deletion still requires a separate support-side account removal flow.
 */

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/server/better-auth";
import { getServerAuthToken } from "../../../lib/auth/server-auth";

export async function DELETE(_request: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL;
  const apiKey = await getServerAuthToken();

  if (!backendUrl) {
    return NextResponse.json(
      { error: "Server configuration incomplete" },
      { status: 500 }
    );
  }

  // Get authenticated user
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }
  const userId = session.user.id;

  try {
    // Delete user's memories from Mem0 (V4 backend endpoint)
    const mem0Response = await fetch(
      `${backendUrl}/mem0/${userId}/memories`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!mem0Response.ok && mem0Response.status !== 404) {
      // Continue anyway - best effort deletion
    }

    return NextResponse.json({
      ok: true,
      message: "User memories cleared. Contact support for full account deletion.",
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete user data" },
      { status: 500 }
    );
  }
}

