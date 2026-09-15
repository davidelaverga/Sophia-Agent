import { setTimeout as pause } from 'node:timers/promises';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOCATION = new RegExp(`^/threads/(${UUID})/runs/(${UUID})$`);

async function boundedRun(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!body) return null;
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      // The installed API can include original kwargs. Keep them transient,
      // bounded and unlogged; never expose them as a completion receipt.
      if (bytes > 16 * 1024 * 1024) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Completion only, never permission to reuse memory or a model admission.
 * The installed server issues relative Content-Location and owner-filters GET
 * /threads/{thread}/runs/{run}. Never follow a provider-supplied URL or infer
 * success from EOF, text, an artifact, or a different run on the same thread.
 */
export function createRunCompletionCheck({ backendUrl, threadId, upstream, token, signal }: {
  backendUrl: string; threadId: string; upstream: Response; token: string | null; signal?: AbortSignal;
}): () => Promise<boolean> {
  const location = upstream.headers.get('content-location')?.match(LOCATION);
  const runId = location?.[1] === threadId ? location[2] : null;
  const url = runId ? `${backendUrl}/${threadId}/runs/${runId}` : null;
  let used = false;
  return async () => {
    if (used) return false;
    used = true;
    if (!url || !runId || !token || signal?.aborted) return false;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3000)]);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        bounded.throwIfAborted();
        const response = await fetch(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: bounded,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
        if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) {
          await response.body?.cancel().catch(() => undefined);
          return false;
        }
        const value = await boundedRun(response.body);
        bounded.throwIfAborted();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        if (row.run_id !== runId || row.thread_id !== threadId) return false;
        if (row.status === 'success') return true;
        if (!['pending', 'running'].includes(String(row.status)) || attempt === 2) return false;
        await pause(100, undefined, { signal: bounded });
      }
    } catch { /* Unavailable authority or transport never confirms completion. */ }
    return false;
  };
}
