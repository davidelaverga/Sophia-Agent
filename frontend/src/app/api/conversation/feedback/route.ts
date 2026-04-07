import { type NextRequest, NextResponse } from "next/server";

import { getServerAuthToken } from "../../../lib/auth/server-auth";

export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL;
  const apiKey = await getServerAuthToken();

  if (!backendUrl) {
    return NextResponse.json({ error: "Server configuration incomplete" }, { status: 500 });
  }

  let body: { turn_id: string; helpful: boolean; tag?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!body.turn_id || typeof body.helpful !== "boolean") {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const response = await fetch(`${backendUrl}/api/v1/conversation/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
      return NextResponse.json(errorData, { status: response.status });
    }

    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to submit feedback" }, { status: 500 });
  }
}

