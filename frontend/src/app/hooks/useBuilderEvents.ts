'use client';

import { useEffect, useState } from 'react';

import { env } from '../../env';
import type { BuilderCompletionEventV1 } from '../types/builder-completion';

/**
 * Subscribe to builder completion events for a thread.
 *
 * Wires to the gateway's SSE endpoint
 * (`GET /api/threads/{thread_id}/builder-events`). On mount, also probes
 * `/last` so a fast-mounting tab immediately sees the most recent event
 * if one fired during the silent gap (before the SSE subscription was
 * live).
 *
 * Pass ``enabled=false`` to skip the subscription (e.g. when there's no
 * active builder task to watch). The hook returns the latest event
 * received, or ``null`` until one arrives.
 */
export function useBuilderEvents(
  threadId: string | null | undefined,
  options?: { enabled?: boolean },
): BuilderCompletionEventV1 | null {
  const [event, setEvent] = useState<BuilderCompletionEventV1 | null>(null);
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled || !threadId) {
      setEvent(null);
      return;
    }

    const baseUrl = env.NEXT_PUBLIC_GATEWAY_URL ?? '';
    const lastUrl = `${baseUrl}/api/threads/${encodeURIComponent(threadId)}/builder-events/last`;
    const streamUrl = `${baseUrl}/api/threads/${encodeURIComponent(threadId)}/builder-events`;

    let cancelled = false;

    // Late-mount recovery: if the event already fired and is still in the
    // 5-minute TTL cache, surface it immediately so the UI renders without
    // waiting for the SSE handshake.
    //
    // ``fetch`` is wrapped defensively so that environments without a
    // global fetch (some test runners, restricted Capacitor builds) don't
    // crash the hook — we just skip recovery and rely on SSE.
    if (typeof fetch === 'function') {
      try {
        void fetch(lastUrl, { credentials: 'include' })
          .then(async (resp) => {
            if (cancelled) return;
            if (resp.status === 200) {
              const payload = (await resp.json()) as BuilderCompletionEventV1;
              setEvent(payload);
            }
          })
          .catch(() => {
            // Network blip on /last is fine — SSE will catch the next event.
          });
      } catch {
        // Synchronous fetch error (fetch not callable, etc.) — fall through
        // to the SSE subscription.
      }
    }

    if (typeof EventSource !== 'function') {
      return () => {
        cancelled = true;
      };
    }

    const source = new EventSource(streamUrl, { withCredentials: true });
    source.onmessage = (e) => {
      if (cancelled) return;
      try {
        const parsed = JSON.parse(e.data) as BuilderCompletionEventV1;
        setEvent(parsed);
      } catch {
        // Ignore malformed payloads — gateway should never emit them.
      }
    };
    source.onerror = () => {
      // Browser auto-retries on transient drops. Only close on permanent
      // failure (readyState=CLOSED). EventSource's default retry timer is
      // ~3s which matches our needs.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
      }
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, [threadId, enabled]);

  return event;
}
