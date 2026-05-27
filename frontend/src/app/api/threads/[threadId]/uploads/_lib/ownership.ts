/**
 * Shared thread-ownership lookup for the upload proxy routes.
 *
 * Both POST (multipart upload) and DELETE (remove-uploaded-file)
 * need to verify the authenticated user owns the target threadId
 * before forwarding to the gateway. Extracted into one helper so
 * a future change to the lookup strategy (e.g. switching the
 * source endpoint or caching results) flows through both routes.
 *
 * See ``../route.ts`` for the rationale on:
 * - Why ``/api/v1/sessions/open`` is the right endpoint (Codex P1
 *   PR #132 — gateway mount prefix is ``/api/v1/sessions``; the
 *   browser-origin sessions proxy rewrites for us, but this
 *   server-side direct call must use the full path).
 * - Why ``/open`` (no limit) rather than ``/list`` (capped at
 *   100) (Codex P2 — power users with >100 sessions otherwise get
 *   falsely 403'd).
 * - Why we fail closed on every error path (network failure,
 *   non-200, malformed JSON, missing field).
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
