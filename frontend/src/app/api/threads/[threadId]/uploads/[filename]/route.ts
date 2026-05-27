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

// Match the backend's resolver-level cap; longer values wouldn't
// survive most filesystems and are almost certainly malformed.
const MAX_FILENAME_LENGTH = 255;

function isSafeThreadId(value: string | undefined): value is string {
  return Boolean(value) && /^[a-zA-Z0-9_-]+$/.test(value!);
}

/**
 * Mirrors the Python-side ``view_user_image._is_safe_filename``:
 * reject empty / ``.`` / ``..`` / path separators / dotfiles /
 * oversized / control chars. Anything else is a legitimate filename
 * that the gateway upload route accepts.
 *
 * Codex P2 PR #132: an earlier version of this validator used a
 * strict allow-list (``[A-Za-z0-9._-]+``) borrowed from the
 * builder-side prompt-injection guards. That was overly strict for
 * the DELETE path — a perfectly normal filename like
 * ``Screenshot 2026-05-27 at 10.00.png`` (spaces) would be
 * accepted by the upload route, then rejected by DELETE, leaving
 * the chip stuck in error and the bytes stranded on disk. The
 * DELETE allow-list now matches what the upload-side actually
 * admits. The builder-side strict regex still protects the prompt
 * downstream — a separate concern from this proxy's job of letting
 * the user remove what they uploaded.
 */
function isSafeFilename(value: string | undefined): value is string {
  if (!value || value === "." || value === "..") return false;
  if (value.length > MAX_FILENAME_LENGTH) return false;
  // Path separators — POSIX and Windows.
  if (value.includes("/") || value.includes("\\")) return false;
  // Hidden files (leading dot) — consistent with
  // ``view_user_image._is_safe_filename``; keeps ``.DS_Store`` /
  // ``.env`` style names unaddressable.
  if (value.startsWith(".")) return false;
  // Control characters (0x00–0x1F + DEL 0x7F). Newlines/NUL in a
  // filename are pathological and the upload route wouldn't have
  // produced them; reject defensively.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
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
