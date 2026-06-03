import { useCallback, useEffect, useRef, useState } from 'react';

import { normalizeBuilderArtifactPath } from '../lib/builder-artifacts';
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
    .map((item): BuilderArtifactLibraryItemV1 | null => {
      const path = normalizeBuilderArtifactPath(item.path);
      const name = typeof item.name === 'string' ? item.name.trim() : '';

      if (!path || !name) {
        return null;
      }

      return {
        path,
        name,
        ...(typeof item.size_bytes === 'number' ? { sizeBytes: item.size_bytes } : {}),
        ...(typeof item.mime_type === 'string' && item.mime_type ? { mimeType: item.mime_type } : {}),
        ...(typeof item.modified_at === 'string' && item.modified_at ? { modifiedAt: item.modified_at } : {}),
      };
    })
    .filter((item): item is BuilderArtifactLibraryItemV1 => item !== null);
}

async function fetchBuilderArtifactLibrary(
  requestedThreadId: string,
  signal?: AbortSignal,
): Promise<BuilderArtifactLibraryResponse | null> {
  const response = await fetch(`/api/threads/${encodeURIComponent(requestedThreadId)}/artifacts`, {
    method: 'GET',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json() as BuilderArtifactLibraryResponse;
  return typeof payload.thread_id === 'string' && payload.thread_id !== requestedThreadId
    ? null
    : payload;
}

function useClearLibraryWhenThreadMissing(
  threadId: string | undefined,
  reset: () => void,
) {
  useEffect(() => {
    if (threadId) return;
    reset();
  }, [reset, threadId]);
}

function useLoadLibraryOnThreadChange(
  threadId: string | undefined,
  refreshToken: string | undefined,
  load: (signal?: AbortSignal) => void,
) {
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, refreshToken, threadId]);
}

function usePollLibrary(
  threadId: string | undefined,
  pollIntervalMs: number | null | undefined,
  load: () => void,
) {
  useEffect(() => {
    if (!threadId || !pollIntervalMs || pollIntervalMs <= 0) return;
    const interval = window.setInterval(load, pollIntervalMs);
    return () => {
      window.clearInterval(interval);
    };
  }, [load, pollIntervalMs, threadId]);
}

function useRefreshLibraryOnFocus(
  threadId: string | undefined,
  refreshOnFocus: boolean,
  load: () => void,
) {
  useEffect(() => {
    if (!threadId || !refreshOnFocus || typeof window === 'undefined') return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        load();
      }
    };
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load, refreshOnFocus, threadId]);
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
      const payload = await fetchBuilderArtifactLibrary(requestedThreadId, signal);
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

  const reset = useCallback(() => {
    setItems([]);
    setIsLoading(false);
  }, []);
  const loadWithSignal = useCallback((signal?: AbortSignal) => {
    void load(signal);
  }, [load]);
  const loadWithoutSignal = useCallback(() => {
    void load();
  }, [load]);

  useClearLibraryWhenThreadMissing(threadId, reset);
  useLoadLibraryOnThreadChange(threadId, refreshToken, loadWithSignal);
  usePollLibrary(threadId, pollIntervalMs, loadWithoutSignal);
  useRefreshLibraryOnFocus(threadId, refreshOnFocus, loadWithoutSignal);

  return {
    items,
    isLoading,
  };
}
