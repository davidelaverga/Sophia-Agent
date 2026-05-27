/**
 * DELETE proxy for a single uploaded attachment.
 *
 * Forwards ``DELETE /api/threads/{threadId}/uploads/{filename}``
 * to the backend gateway's ``DELETE
 * /api/threads/{thread_id}/uploads/{filename}`` so removing a chip
 * in the AttachmentBar also removes the bytes from
 * ``backend/.deer-flow/threads/{threadId}/user-data/uploads/``.
 *
 * **Why this matters** (Codex P2 PR #132): before this route
 * existed, the chip × button only cleared the local Zustand entry.
 * The file remained on disk and ``start_builder_task.
 * _copy_parent_uploaded_images`` would later enumerate every image
 * in the parent's uploads directory and surface it in the builder
 * briefing — so a file the user explicitly discarded could still
 * reach the builder despite never being in ``attached_files``.
 *
 * Auth + ownership semantics mirror the POST route: same Better
 * Auth session check, same gateway Bearer token, same
 * ``userOwnsThread`` gate. We never DELETE on someone else's
 * thread.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUserId, getUserScopedAuthToken } from "../../../../../lib/auth/server-auth";
import { getPrimaryGatewayUrl } from "../../../../_lib/gateway-url";
import { userOwnsThread } from "../_lib/ownership";

// Same allow-list as ``view_user_image`` / the prompt-injection
// guard in ``builder_task._SAFE_UPLOADED_IMAGE_PATH``: alphanumerics,
// dot, underscore, dash. Anything else can't be a legitimate
// filename written by our gateway upload route (which itself
// rejects path separators via ``Path(file.filename).name``), and
// admitting other characters here would risk path traversal even
// after ``encodeURIComponent``.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
// Match the backend's resolver-level cap; longer values wouldn't
// survive most filesystems and are almost certainly malformed.
const MAX_FILENAME_LENGTH = 255;

function isSafeThreadId(value: string | undefined): value is string {
  return Boolean(value) && /^[a-zA-Z0-9_-]+$/.test(value!);
}

function isSafeFilename(value: string | undefined): value is string {
  if (!value || value === "." || value === "..") return false;
  // Reject hidden files (leading dot). Mirrors the Python-side
  // ``view_user_image._is_safe_filename`` so the two stay consistent
  // — a ``.DS_Store`` or ``.env`` should never be addressable here
  // even though the character set otherwise allows ``.``.
  if (value.startsWith(".")) return false;
  if (value.length > MAX_FILENAME_LENGTH) return false;
  return SAFE_FILENAME.test(value);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ threadId: string; filename: string }> },
): Promise<Response> {
  const { threadId, filename } = await context.params;

  if (!isSafeThreadId(threadId)) {
    return NextResponse.json({ error: "Invalid threadId" }, { status: 400 });
  }
  if (!isSafeFilename(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
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

  const targetUrl =
    `${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}/uploads/${encodeURIComponent(filename)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // ``request`` is unused — DELETE has no body and we don't read
  // headers off of it. Tagged here so a future contributor doesn't
  // wonder if we're dropping something silently.
  void request;

  try {
    const upstream = await fetch(targetUrl, { method: "DELETE", headers });
    if (!upstream.ok) {
      const errorText = await upstream.text();
      return NextResponse.json(
        {
          error: `Gateway delete failed (${upstream.status})`,
          detail: errorText.slice(0, 500),
        },
        { status: upstream.status },
      );
    }
    const data = await upstream.json().catch(() => ({ ok: true }));
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to reach gateway: ${message}` },
      { status: 502 },
    );
  }
}
