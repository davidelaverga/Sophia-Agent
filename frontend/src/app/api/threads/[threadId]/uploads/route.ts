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
 *
 * Thread-ownership check (Codex P1 on PR #132): the backend gateway's
 * upload endpoint (``backend/app/gateway/routers/uploads.py``) writes
 * directly to ``sandbox_uploads_dir(thread_id)`` without verifying the
 * caller owns the thread. Without an ownership check on this proxy,
 * an authenticated user could place files in another user's thread by
 * guessing/learning that thread's UUID — and PR #132's
 * ``view_user_image`` / ``_copy_parent_uploaded_images`` would then
 * surface that attacker-supplied content to the victim's session or
 * builder. We close the gap here by looking up the user's sessions
 * via the backend's ``/api/sessions/list`` endpoint and verifying
 * the requested ``threadId`` belongs to the authenticated user before
 * forwarding the multipart body. Fails closed on any error.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUserId, getUserScopedAuthToken } from "../../../../lib/auth/server-auth";
import { getPrimaryGatewayUrl } from "../../../_lib/gateway-url";

// Mirrors the FastAPI uploads route's accepted set + a sane cap to keep
// the proxy from streaming pathological payloads.
const MAX_TOTAL_UPLOAD_BYTES = 60 * 1024 * 1024; // 60 MB across all files in one request

// Upper bound for the ownership-lookup page size. 100 matches the
// gateway endpoint's ``limit`` ceiling and comfortably covers any
// realistic per-user session history. If a user somehow has >100
// sessions and the target thread is older than the most recent 100,
// the upload is rejected — acceptable trade-off for not iterating
// a paginated lookup on every upload.
const OWNERSHIP_LOOKUP_LIMIT = 100;


/**
 * Confirm that ``threadId`` belongs to ``userId`` by listing the
 * user's sessions via the gateway. Returns ``true`` only on an
 * explicit match; any error path (network failure, malformed
 * response, mismatched thread) fails closed.
 *
 * The Bearer header carries the user-scoped backend token, so the
 * gateway sees the same identity that authenticated against
 * Better Auth on the Next.js side. Backend hardening (binding
 * ``user_id`` query to the auth token rather than trusting it as a
 * query param) is a separate concern tracked in the PR thread.
 */
async function userOwnsThread(
  threadId: string,
  userId: string,
  apiKey: string | null,
  gatewayUrl: string,
): Promise<boolean> {
  const url = `${gatewayUrl}/api/sessions/list?user_id=${encodeURIComponent(userId)}&limit=${OWNERSHIP_LOOKUP_LIMIT}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      return false;
    }
    const data = (await res.json()) as { sessions?: Array<{ thread_id?: unknown }> };
    if (!Array.isArray(data.sessions)) {
      return false;
    }
    return data.sessions.some((session) => session?.thread_id === threadId);
  } catch {
    return false;
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  const { threadId } = await context.params;

  // Order matters here: we want every cheap, local rejection to fire
  // BEFORE the expensive ones (network round-trips, body buffering).
  // The pipeline is:
  //   1. threadId format check (cheap, local)
  //   2. auth check (cheap, local)
  //   3. content-length cap (cheap, local — keeps a malicious 1 GB body
  //      from being buffered into memory just to be rejected post-parse)
  //   4. thread-ownership check (one HTTP round-trip — see userOwnsThread)
  //   5. body parse (expensive — buffers the multipart into memory)
  //   6. per-batch size cap (backstop in case content-length lied / was
  //      missing for a chunked upload)
  //   7. forward to backend

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

  // Codex P2 on PR #132: enforce the envelope cap on the
  // ``content-length`` header BEFORE calling ``request.formData()``
  // (which buffers the entire multipart body into memory). A logged-in
  // attacker who bypasses the file picker and posts a 1 GB body
  // shouldn't be able to make the Next.js process spend memory on it.
  // Chunked uploads without ``content-length`` fall through to the
  // post-parse backstop below — we accept the latency cost there
  // because chunk-encoded multipart from a browser is unusual.
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `Upload too large (${contentLength} bytes per content-length header). Max ${MAX_TOTAL_UPLOAD_BYTES} bytes per request.`,
        },
        { status: 413 }
      );
    }
  }

  const gatewayUrl = getPrimaryGatewayUrl();
  const apiKey = await getUserScopedAuthToken();

  // Codex P1: verify the authenticated user owns this threadId before
  // forwarding. Without this check, a logged-in user who learns
  // another user's threadId could plant files in that thread's
  // sandbox — which view_user_image and the builder image-copy path
  // would then surface to the victim. Moved up here (before body
  // parse) so the ownership-failure path also avoids buffering the
  // entire multipart payload — Codex P2 part 2.
  const owns = await userOwnsThread(threadId, userId, apiKey, gatewayUrl);
  if (!owns) {
    return NextResponse.json(
      { error: "Thread not owned by current user" },
      { status: 403 },
    );
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
    // Post-parse backstop: caps chunked uploads (no content-length)
    // and any case where the client lied about content-length.
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

  const targetUrl = `${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}/uploads`;

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
