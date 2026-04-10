import { type NextRequest, NextResponse } from "next/server";

import { getUserScopedAuthHeader, refreshUserScopedAuthHeader } from "../../../lib/auth/server-auth";

export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL;

  if (!backendUrl) {
    return NextResponse.json({ error: "Server configuration incomplete" }, { status: 500 });
  }

  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
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
    const execute = (authorization: string) => fetch(`${backendUrl}/api/v1/conversation/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify(body),
    });

    let response = await execute(authHeader);

    if (response.status === 401 || response.status === 403) {
      const refreshedAuthHeader = await refreshUserScopedAuthHeader();
      if (refreshedAuthHeader && refreshedAuthHeader !== authHeader) {
        response = await execute(refreshedAuthHeader);
      }
    }

    // Feedback is optional analytics. If the backend surface is absent, do not fail the UI.
    if (response.status === 404) {
      return new NextResponse(null, { status: 204 });
    }

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

