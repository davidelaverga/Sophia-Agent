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

/**
 * Confirm that ``threadId`` belongs to ``userId`` by listing the
 * user's open (resumable) sessions via the gateway. Returns
 * ``true`` only on an explicit match; any error path fails closed.
 */
export async function userOwnsThread(
  threadId: string,
  userId: string,
  apiKey: string | null,
  gatewayUrl: string,
): Promise<boolean> {
  const url = `${gatewayUrl}/api/v1/sessions/open?user_id=${encodeURIComponent(userId)}`;
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
