import { useEffect, useState, useCallback } from 'react';

import { mockRecapArtifacts } from '../../components/recap/mockData';
import { mapBackendArtifactsToRecapV1 } from '../../lib/artifacts-adapter';
import { logger } from '../../lib/error-logger';
import type { RecapArtifactsV1 } from '../../lib/recap-types';
import { clearRecentSessionEndHint, getRecentSessionEndHint } from '../../lib/recent-session-end';
import { useSessionHistoryStore } from '../../stores/session-history-store';

const RECENT_END_RETRY_DELAY_MS = 1500;
const RECENT_END_MAX_RETRIES = 6;

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
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const loadArtifacts = async () => {
      setStatus('loading');

      const recentEndHint = getRecentSessionEndHint();
      const isRecentEndedSession = recentEndHint?.sessionId === sessionId;

      const scheduleRecentRetry = () => {
        if (!isRecentEndedSession) {
          return false;
        }

        if (retryCount >= RECENT_END_MAX_RETRIES) {
          clearRecentSessionEndHint();
          setStatus('unavailable');
          return true;
        }

        setStatus('processing');
        retryTimer = setTimeout(() => {
          setRetryCount((current) => current + 1);
        }, RECENT_END_RETRY_DELAY_MS);
        return true;
      };

      if (artifacts) {
        if (isRecentEndedSession) {
          clearRecentSessionEndHint();
        }
        useSessionHistoryStore.getState().markRecapViewed(sessionId);
        setStatus('ready');
        return;
      }

      try {
        const response = await fetch(`/api/sophia/sessions/${sessionId}/recap`, {
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
            if (isRecentEndedSession) {
              clearRecentSessionEndHint();
            }
            setArtifacts(sessionId, mapped);
            useSessionHistoryStore.getState().markRecapViewed(sessionId);
            setStatus('ready');
            return;
          }

          if (scheduleRecentRetry()) {
            return;
          }

          setStatus('processing');
          return;
        }

        if (response.status === 404) {
          if (scheduleRecentRetry()) {
            return;
          }

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

    return () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
    };
  }, [sessionId, artifacts, setArtifacts, retryCount]);

  const reload = useCallback(() => {
    setStatus('loading');
    window.location.reload();
  }, []);

  return {
    status,
    reload,
  };
}
