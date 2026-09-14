// Ephemeral cross-tab invalidation only. Never carries text, IDs, receipts or
// permission to reuse cached memory. Canonical reads and server fences remain
// mandatory even when browser delivery is unavailable or delayed.
const channelName = (owner: string) => `sophia.memory.view-invalidation.v1:${encodeURIComponent(owner)}`;
const sender = crypto.randomUUID();
export function notifyMemoryViews(owner: string | null | undefined): boolean {
  if (!owner || typeof BroadcastChannel === 'undefined') return false;
  let channel: BroadcastChannel | undefined;
  let queued = false;
  try {
    channel = new BroadcastChannel(channelName(owner));
    channel.postMessage({ kind: 'revalidate', sender });
    queued = true;
  } catch { queued = false; } finally {
    try { channel?.close(); } catch { queued = false; }
  }
  return queued; // Local enqueue only, never acknowledgement by another tab.
}

export function observeMemoryViews(owner: string | null, invalidate: () => void): () => void {
  if (!owner || typeof BroadcastChannel === 'undefined') return () => {};
  try {
    const channel = new BroadcastChannel(channelName(owner));
    channel.onmessage = event => {
      if (event.data?.sender !== sender) invalidate(); // Unknown payloads cannot authorize.
    };
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      channel.onmessage = null;
      try { channel.close(); } catch { /* Cleanup cannot change canonical results. */ }
    };
  } catch { return () => {}; }
}
