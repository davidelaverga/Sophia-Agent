/**
 * Shared thread-ownership lookup for server-side routes that
 * forward thread-scoped requests to the backend gateway.
 *
 * Used by:
 * - ``/api/threads/[threadId]/uploads`` (POST proxy)
 * - ``/api/threads/[threadId]/uploads/[filename]`` (DELETE proxy)
 * - ``/api/chat`` post-handler (only when ``attached_files`` is
 *   non-empty — Codex P1 PR #132)
 *
 * Rationale (Codex P1/P2 PR #132):
 *
 * - **``/api/v1/sessions/open`` is load-bearing**: the backend
 *   gateway mounts the sessions router with
 *   ``prefix="/api/v1/sessions"``. The browser-origin proxy at
 *   ``/api/sessions/[...path]`` rewrites un-versioned calls, but
 *   server-side direct gateway calls (like this one) need the
 *   full ``/api/v1/`` prefix or they 404 → fail-closed.
 *
 * - **``/open`` rather than ``/list``**: ``/list`` caps at 100
 *   entries server-side; a power user with >100 sessions whose
 *   target thread is older than the most recent 100 would get
 *   falsely 403'd. ``/open`` returns ALL resumable sessions with
 *   no limit. Uploads (and chat sends) only happen on active
 *   sessions anyway.
 *
 * - **Fails closed on every error path**: network failure,
 *   non-200, malformed JSON, missing field — all return ``false``.
 *   Better to reject a legitimate request than to forward a
 *   spoofed one.
 *
 * - **Backend hardening caveat**: the gateway's session endpoints
 *   currently accept ``user_id`` as a query param without binding
 *   it to the auth token. The proxy still presents the
 *   authenticated user_id + Bearer token, so a correctly-
 *   implemented backend would refuse mismatches. Worth a separate
 *   backend ticket so the proxy isn't the only line of defense.
 */

// How many entries to pull from ``/list`` on the fallback lookup.
// 100 is the gateway's documented ceiling. Sessions older than the
// most recent 100 still 403; that's an acceptable edge case for
// power users and the right long-term fix is a dedicated
// ``/api/v1/sessions/by-thread/{thread_id}`` lookup (separate
// backend ticket).
const OWNERSHIP_FALLBACK_LIMIT = 100;

async function fetchSessionsThreadIds(
  url: string,
  apiKey: string | null,
): Promise<string[] | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { sessions?: Array<{ thread_id?: unknown }> };
    if (!Array.isArray(data.sessions)) {
      return null;
    }
    const ids: string[] = [];
    for (const session of data.sessions) {
      if (typeof session?.thread_id === "string") {
        ids.push(session.thread_id);
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Confirm that ``threadId`` belongs to ``userId``. Returns ``true``
 * only on an explicit match; any error path fails closed.
 *
 * **Two-pass lookup** (Codex P2 PR #132):
 *
 * 1. ``/api/v1/sessions/open`` — primary path. Unbounded list of
 *    resumable sessions. Covers the common case (user uploading
 *    in an active or paused session).
 * 2. ``/api/v1/sessions/list?limit=100`` — fallback. Necessary for
 *    ended-but-restored sessions: ``restoreOpenSession`` marks an
 *    ended session as interactive locally BEFORE the backend
 *    touch reopens it, and ``/open`` excludes ended records. In
 *    that window, an upload/DELETE without the fallback would 403
 *    until the user sent a non-attachment message that reactivates
 *    the session. ``/list`` includes ended sessions.
 *
 * Sessions outside the recent 100 in ``/list`` still 403. Long-term
 * fix is a dedicated ``/by-thread/{thread_id}`` endpoint on the
 * gateway; that's a separate backend ticket.
 */
export async function userOwnsThread(
  threadId: string,
  userId: string,
  apiKey: string | null,
  gatewayUrl: string,
): Promise<boolean> {
  const encodedUser = encodeURIComponent(userId);

  const openIds = await fetchSessionsThreadIds(
    `${gatewayUrl}/api/v1/sessions/open?user_id=${encodedUser}`,
    apiKey,
  );
  if (openIds?.includes(threadId)) {
    return true;
  }

  const listIds = await fetchSessionsThreadIds(
    `${gatewayUrl}/api/v1/sessions/list?user_id=${encodedUser}&limit=${OWNERSHIP_FALLBACK_LIMIT}`,
    apiKey,
  );
  if (listIds?.includes(threadId)) {
    return true;
  }

  return false;
}
