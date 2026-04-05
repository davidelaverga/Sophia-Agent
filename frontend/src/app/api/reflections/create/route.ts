import { NextRequest, NextResponse } from "next/server";
import { getServerAuthToken } from "../../../lib/auth/server-auth";

export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL;
  const apiKey = await getServerAuthToken();

  if (!backendUrl) {
    return NextResponse.json({ error: "Server configuration incomplete" }, { status: 500 });
  }

  let body: { conversation_id: string; chunk_id: string; action: "save" | "share_discord"; user_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!body.conversation_id || !body.chunk_id || !body.action) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    // Call backend /api/reflections/run with share_to_discord flag
    const shareToDiscord = body.action === "share_discord";
    
    const response = await fetch(`${backendUrl}/api/reflections/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        conversation_id: body.conversation_id,
        user_id: body.user_id || "anonymous",
        share_to_discord: shareToDiscord,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
      return NextResponse.json(errorData, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json({ 
      ok: true, 
      reflection_id: data.id,
      shared: data.shared || false,
    });
  } catch {
    return NextResponse.json({ error: "Failed to create reflection" }, { status: 500 });
  }
}

