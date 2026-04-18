import { useEffect, useState } from 'react';

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
}: {
  threadId?: string;
  refreshToken?: string;
}) {
  const [items, setItems] = useState<BuilderArtifactLibraryItemV1[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!threadId) {
      setItems([]);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/artifacts`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        });

        if (!response.ok) {
          if (!cancelled) {
            setItems([]);
          }
          return;
        }

        const payload = await response.json() as BuilderArtifactLibraryResponse;
        if (!cancelled) {
          setItems(normalizeBuilderArtifactLibrary(payload));
        }
      } catch {
        if (!cancelled && !controller.signal.aborted) {
          setItems([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [refreshToken, threadId]);

  return {
    items,
    isLoading,
  };
}