import { useCallback, useEffect, useRef, useState } from 'react';

import type { BuilderArtifactLibraryItemV1 } from '../types/builder-artifact';

type BuilderArtifactLibraryResponse = {
  thread_id?: string;
  artifacts?: Array<{
    path?: string;
    name?: string;
    size_bytes?: number;
    mime_type?: string | null;
    modified_at?: string | null;
  }>;
};

function normalizeBuilderArtifactLibrary(
  payload: BuilderArtifactLibraryResponse | null,
): BuilderArtifactLibraryItemV1[] {
  if (!payload || !Array.isArray(payload.artifacts)) {
    return [];
  }

  return payload.artifacts
    .filter((item): item is NonNullable<BuilderArtifactLibraryResponse['artifacts']>[number] => Boolean(item))
    .filter((item): item is NonNullable<BuilderArtifactLibraryResponse['artifacts']>[number] & { path: string; name: string } => (
      typeof item.path === 'string'
      && item.path.trim().length > 0
      && typeof item.name === 'string'
      && item.name.trim().length > 0
    ))
    .map((item) => ({
      path: item.path,
      name: item.name,
      ...(typeof item.size_bytes === 'number' ? { sizeBytes: item.size_bytes } : {}),
      ...(typeof item.mime_type === 'string' && item.mime_type ? { mimeType: item.mime_type } : {}),
      ...(typeof item.modified_at === 'string' && item.modified_at ? { modifiedAt: item.modified_at } : {}),
    }));
}

export function useSessionBuilderArtifactLibrary({
  threadId,
  refreshToken,
  pollIntervalMs,
  refreshOnFocus = true,
}: {
  threadId?: string;
  refreshToken?: string;
  pollIntervalMs?: number | null;
  refreshOnFocus?: boolean;
}) {
  const [items, setItems] = useState<BuilderArtifactLibraryItemV1[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const activeThreadRef = useRef<string | undefined>(threadId);
  const latestRequestRef = useRef(0);

  activeThreadRef.current = threadId;

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestedThreadId = threadId;
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    const isCurrentRequest = () => (
      !signal?.aborted
      && activeThreadRef.current === requestedThreadId
      && latestRequestRef.current === requestId
    );

    if (!requestedThreadId) {
      setItems([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(requestedThreadId)}/artifacts`, {
        method: 'GET',
        cache: 'no-store',
        signal,
      });

      if (!response.ok) {
        if (isCurrentRequest()) {
          setItems([]);
        }
        return;
      }

      const payload = await response.json() as BuilderArtifactLibraryResponse;
      if (typeof payload.thread_id === 'string' && payload.thread_id !== requestedThreadId) {
        return;
      }
      if (isCurrentRequest()) {
        setItems(normalizeBuilderArtifactLibrary(payload));
      }
    } catch {
      if (isCurrentRequest()) {
        setItems([]);
      }
    } finally {
      if (isCurrentRequest()) {
        setIsLoading(false);
      }
    }
  }, [threadId]);

  useEffect(() => {
    if (threadId) return;
    setItems([]);
    setIsLoading(false);
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, refreshToken, threadId]);

  useEffect(() => {
    if (!threadId || !pollIntervalMs || pollIntervalMs <= 0) return;
    const interval = window.setInterval(() => {
      void load();
    }, pollIntervalMs);
    return () => {
      window.clearInterval(interval);
    };
  }, [load, pollIntervalMs, threadId]);

  useEffect(() => {
    if (!threadId || !refreshOnFocus || typeof window === 'undefined') return;
    const refresh = () => {
      void load();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load, refreshOnFocus, threadId]);

  return {
    items,
    isLoading,
  };
}
