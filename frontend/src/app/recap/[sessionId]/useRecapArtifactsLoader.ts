import { useEffect, useState, useCallback } from 'react';
import { logger } from '../../lib/error-logger';
import { useSessionHistoryStore } from '../../stores/session-history-store';
import { mapBackendArtifactsToRecapV1 } from '../../lib/artifacts-adapter';
import { mockRecapArtifacts } from '../../components/recap/mockData';
import type { RecapArtifactsV1 } from '../../lib/recap-types';

export type RecapPageStatus = 'loading' | 'ready' | 'processing' | 'unavailable' | 'not_found';

interface UseRecapArtifactsLoaderParams {
  sessionId: string;
  artifacts: RecapArtifactsV1 | null;
  setArtifacts: (sessionId: string, artifacts: RecapArtifactsV1) => void;
}

interface UseRecapArtifactsLoaderResult {
  status: RecapPageStatus;
  reload: () => void;
}

export function useRecapArtifactsLoader({
  sessionId,
  artifacts,
  setArtifacts,
}: UseRecapArtifactsLoaderParams): UseRecapArtifactsLoaderResult {
  const [status, setStatus] = useState<RecapPageStatus>('loading');

  useEffect(() => {
    const loadArtifacts = async () => {
      setStatus('loading');

      if (artifacts) {
        useSessionHistoryStore.getState().markRecapViewed(sessionId);
        setStatus('ready');
        return;
      }

      try {
        const response = await fetch(`/api/sessions/${sessionId}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const data = await response.json() as Record<string, unknown>;

          const nestedArtifacts = (data?.recap_artifacts || data?.artifacts) as Record<string, unknown> | undefined;

          const hasTopLevelArtifacts =
            typeof data?.takeaway === 'string' ||
            typeof data?.reflection_candidate === 'string' ||
            (data?.reflection_candidate && typeof data?.reflection_candidate === 'object') ||
            Array.isArray(data?.memory_candidates);

          const fallbackTopLevelArtifacts = hasTopLevelArtifacts
            ? {
                ...data,
                session_id: (data?.session_id as string | undefined) || sessionId,
                session_type: (data?.session_type as string | undefined),
                context_mode: (data?.context_mode as string | undefined) || (data?.preset_context as string | undefined),
                started_at: (data?.started_at as string | undefined),
                ended_at: (data?.ended_at as string | undefined),
              }
            : null;

          const artifactsPayload = nestedArtifacts
            ? {
                ...nestedArtifacts,
                session_id: (data?.session_id as string | undefined) || sessionId,
                session_type: (data?.session_type as string | undefined),
                context_mode: (data?.context_mode as string | undefined) || (data?.preset_context as string | undefined),
                started_at: (data?.started_at as string | undefined),
                ended_at: (data?.ended_at as string | undefined),
              }
            : fallbackTopLevelArtifacts;

          const mapped = mapBackendArtifactsToRecapV1(artifactsPayload, sessionId);

          if (mapped) {
            setArtifacts(sessionId, mapped);
            useSessionHistoryStore.getState().markRecapViewed(sessionId);
            setStatus('ready');
            return;
          }

          setStatus('processing');
          return;
        }

        if (response.status === 404) {
          setStatus('not_found');
          return;
        }
      } catch (error) {
        logger.logError(error, {
          component: 'Recap',
          action: 'fetch_backend',
        });
      }

      if (process.env.NODE_ENV === 'development') {
        logger.debug('Recap', 'Using mock data for development');
        await new Promise((resolve) => setTimeout(resolve, 500));

        const mockWithSessionId = { ...mockRecapArtifacts, sessionId };
        setArtifacts(sessionId, mockWithSessionId);
        useSessionHistoryStore.getState().markRecapViewed(sessionId);
        setStatus('ready');
        return;
      }

      setStatus('unavailable');
    };

    void loadArtifacts();
  }, [sessionId, artifacts, setArtifacts]);

  const reload = useCallback(() => {
    setStatus('loading');
    window.location.reload();
  }, []);

  return {
    status,
    reload,
  };
}
