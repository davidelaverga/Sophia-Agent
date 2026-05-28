/**
 * GET proxy for listing a thread's already-uploaded files.
 *
 * Forwards ``GET /api/threads/{threadId}/uploads/list`` to the
 * backend gateway's ``GET /api/threads/{thread_id}/uploads/list`` so
 * the frontend can see exactly which filenames already exist in
 * ``backend/.deer-flow/threads/{threadId}/user-data/uploads/``.
 *
 * Why this exists (Codex P2 PR #132 — later iteration)
 * ====================================================
 *
 * The ``AttachmentBar`` uniquifier originally seeded its claimed-
 * names set ONLY from chips still in the Zustand store. That's fine
 * for within-batch + still-on-screen collisions, but after a turn
 * sends successfully ``useSessionOutboundSend`` clears the chips
 * while the bytes remain on disk. A later pick of ``image.png`` in
 * the same thread would find an empty store, skip the uniquifier,
 * and silently overwrite the earlier upload. ``view_user_image`` /
 * ``read_user_document`` calls can still reference earlier filenames
 * mentioned in conversation history, so the model would think it's
 * reading the OLD file but actually get the NEW one.
 *
 * This route lets the bar consult server truth before picking
 * filenames. The bar calls it ONCE per file-selection batch and
 * merges the returned filenames into its claimed-names set, so the
 * uniquifier accounts for stale-on-disk files too.
 *
 * Auth + ownership semantics
 * ==========================
 *
 * Mirrors the POST + DELETE routes: Better Auth session for the
 * user, user-scoped backend token as Bearer to the gateway,
 * ``userOwnsThread`` gate so a caller can't enumerate someone
 * else's uploads via this proxy. Fails closed on every error path.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUserId, getUserScopedAuthToken } from "../../../../../lib/auth/server-auth";
import { getPrimaryGatewayUrl } from "../../../../_lib/gateway-url";
import { userOwnsThread } from "../_lib/ownership";

function isSafeThreadId(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  const { threadId } = await context.params;

  if (!isSafeThreadId(threadId)) {
    return NextResponse.json({ error: "Invalid threadId" }, { status: 400 });
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const gatewayUrl = getPrimaryGatewayUrl();
  const apiKey = await getUserScopedAuthToken();

  const owns = await userOwnsThread(threadId, userId, apiKey, gatewayUrl);
  if (!owns) {
    return NextResponse.json(
      { error: "Thread not owned by current user" },
      { status: 403 },
    );
  }

  // ``request`` carries no body and we don't read its headers — the
  // ownership-verified threadId + the Bearer token is everything the
  // gateway needs. Tagged so a future reader doesn't wonder if we're
  // silently dropping a query param.
  void request;

  const targetUrl =
    `${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}/uploads/list`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const upstream = await fetch(targetUrl, { method: "GET", headers });
    if (!upstream.ok) {
      const errorText = await upstream.text();
      return NextResponse.json(
        {
          error: `Gateway list failed (${upstream.status})`,
          detail: errorText.slice(0, 500),
        },
        { status: upstream.status },
      );
    }
    const data = await upstream.json();
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to reach gateway: ${message}` },
      { status: 502 },
    );
  }
}
