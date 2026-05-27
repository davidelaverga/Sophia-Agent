/**
 * Multipart upload proxy for Sophia chat attachments.
 *
 * Forwards `POST /api/threads/{threadId}/uploads` to the backend gateway
 * (`POST {GATEWAY_URL}/api/threads/{threadId}/uploads`) so the file lands
 * in `backend/.deer-flow/threads/{threadId}/user-data/uploads/`.
 *
 * Once it's there, the Sophia companion's `view_user_image(filename)`
 * and `read_user_document(filename)` tools (PR #132) can read it by
 * bare filename. The companion never sees the multipart upload itself
 * — this proxy just gets the bytes into the right thread-scoped
 * sandbox directory.
 *
 * Auth: mirrors the chat route pattern — user is authenticated server
 * side via Better Auth session cookie; the user-scoped backend token
 * is added as a Bearer header when forwarding to the gateway.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUserId, getUserScopedAuthToken } from "../../../../lib/auth/server-auth";
import { getPrimaryGatewayUrl } from "../../../_lib/gateway-url";

// Mirrors the FastAPI uploads route's accepted set + a sane cap to keep
// the proxy from streaming pathological payloads.
const MAX_TOTAL_UPLOAD_BYTES = 60 * 1024 * 1024; // 60 MB across all files in one request

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  const { threadId } = await context.params;

  if (!threadId || !/^[a-zA-Z0-9_-]+$/.test(threadId)) {
    return NextResponse.json(
      { error: "Invalid threadId" },
      { status: 400 }
    );
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart body" },
      { status: 400 }
    );
  }

  // Validate we actually have files and they fit our envelope.
  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { error: "No files provided. Send under the 'files' field name." },
      { status: 400 }
    );
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `Upload too large (${totalBytes} bytes). Max ${MAX_TOTAL_UPLOAD_BYTES} bytes per request.`,
      },
      { status: 413 }
    );
  }

  // Rebuild a fresh FormData so we don't leak any client-only Symbols
  // through fetch's serializer; iterate explicitly to keep filenames.
  const proxied = new FormData();
  for (const file of files) {
    proxied.append("files", file, file.name);
  }

  const gatewayUrl = getPrimaryGatewayUrl();
  const targetUrl = `${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}/uploads`;

  const apiKey = await getUserScopedAuthToken();
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  // NOTE: do NOT set Content-Type here — fetch auto-sets the multipart
  // boundary when body is a FormData. Setting it manually breaks the
  // boundary and the backend rejects the request as malformed.

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: proxied,
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      return NextResponse.json(
        {
          error: `Gateway upload failed (${upstream.status})`,
          detail: errorText.slice(0, 500),
        },
        { status: upstream.status }
      );
    }

    const data = await upstream.json();
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to reach gateway: ${message}` },
      { status: 502 }
    );
  }
}
