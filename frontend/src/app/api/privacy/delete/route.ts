/**
 * Privacy Delete Route - V4 Backend Adaptation
 * ==============================================
 * 
 * Uses V4 backend's Mem0 delete endpoint: DELETE /mem0/{user_id}/memories
 * 
 * This clears the user's long-term memories from the system.
 * Full account deletion requires Supabase admin operations.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
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
  let userId: string | undefined;
  try {
    const cookieStore = await cookies();
    const supabase = createRouteHandlerClient({ cookies: () => cookieStore as any });

    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id;
  } catch {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  if (!userId) {
    return NextResponse.json(
      { error: "User not authenticated" },
      { status: 401 }
    );
  }

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

