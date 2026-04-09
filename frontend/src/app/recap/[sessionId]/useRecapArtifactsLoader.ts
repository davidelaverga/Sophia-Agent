import { useEffect, useState, useCallback } from 'react';

import { mockRecapArtifacts } from '../../components/recap/mockData';
import { mapBackendArtifactsToRecapV1 } from '../../lib/artifacts-adapter';
import { logger } from '../../lib/error-logger';
import type { RecapArtifactsV1 } from '../../lib/recap-types';
import { clearRecentSessionEndHint, getRecentSessionEndHint } from '../../lib/recent-session-end';
import { useSessionHistoryStore } from '../../stores/session-history-store';

const RECENT_END_RETRY_DELAY_MS = 1500;
const RECENT_END_MAX_RETRIES = 6;
const RECENT_END_CONTEXT_WINDOW_MS = 2 * 60 * 1000;

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

interface RecentMemoriesResponse {
  memories?: Array<{
    id?: string;
    text?: string;
    category?: string;
    created_at?: string;
    confidence?: number;
    reason?: string;
  }>;
}

function wasEndedRecently(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const endedAtMs = Date.parse(value);
  if (Number.isNaN(endedAtMs)) {
    return false;
  }

  return Date.now() - endedAtMs <= RECENT_END_CONTEXT_WINDOW_MS;
}

function buildArtifactsPayloadFromStore(
  artifacts: RecapArtifactsV1,
  sessionId: string,
): Record<string, unknown> {
  return {
    session_id: artifacts.sessionId || sessionId,
    session_type: artifacts.sessionType,
    context_mode: artifacts.contextMode,
    started_at: artifacts.startedAt,
    ended_at: artifacts.endedAt,
    takeaway: artifacts.takeaway,
    reflection_candidate: artifacts.reflectionCandidate,
    memory_candidates: artifacts.memoryCandidates?.map((candidate) => ({
      id: candidate.id,
      text: candidate.text,
      memory: candidate.memory,
      category: candidate.category,
      created_at: candidate.created_at,
      confidence: candidate.confidence,
      reason: candidate.reason,
    })),
    status: artifacts.status,
  };
}

export async function hydrateStoredArtifactsWithRecentMemories(
  artifacts: RecapArtifactsV1,
  sessionId: string,
  historyEntry?: { startedAt?: string; endedAt?: string },
): Promise<RecapArtifactsV1 | null> {
  const hydratedStoredPayload = await hydratePayloadWithRecentMemories(
    {
      ...buildArtifactsPayloadFromStore(artifacts, sessionId),
      started_at: artifacts.startedAt || historyEntry?.startedAt,
      ended_at: artifacts.endedAt || historyEntry?.endedAt,
    },
    sessionId,
  );

  return mapBackendArtifactsToRecapV1(hydratedStoredPayload, sessionId);
}

async function hydratePayloadWithRecentMemories(
  payload: Record<string, unknown> | null,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  if (!payload) {
    return null;
  }

  if (Array.isArray(payload.memory_candidates) && payload.memory_candidates.length > 0) {
    return payload;
  }

  const params = new URLSearchParams({
    status: 'pending_review',
    session_id: sessionId,
  });

  if (typeof payload.started_at === 'string') {
    params.set('started_at', payload.started_at);
  }

  if (typeof payload.ended_at === 'string') {
    params.set('ended_at', payload.ended_at);
  }

  try {
    const response = await fetch(`/api/memory/recent?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return payload;
    }

    const recentMemories = await response.json() as RecentMemoriesResponse;
    if (!Array.isArray(recentMemories.memories) || recentMemories.memories.length === 0) {
      return payload;
    }

    return {
      ...payload,
      memory_candidates: recentMemories.memories.map((memory) => ({
        ...(memory.id ? { id: memory.id } : {}),
        text: memory.text,
        category: memory.category,
        ...(memory.created_at ? { created_at: memory.created_at } : {}),
        ...(typeof memory.confidence === 'number' ? { confidence: memory.confidence } : {}),
        ...(memory.reason ? { reason: memory.reason } : {}),
      })),
    };
  } catch (error) {
    logger.logError(error, {
      component: 'Recap',
      action: 'fetch_recent_memories',
    });
    return payload;
  }
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
      const hasRecentEndHint = recentEndHint?.sessionId === sessionId;

      const shouldRetryMemories = (endedAt: string | null | undefined) => {
        return hasRecentEndHint || wasEndedRecently(endedAt);
      };

      const scheduleMemoryRetry = (enabled: boolean) => {
        if (!enabled || retryCount >= RECENT_END_MAX_RETRIES) {
          return false;
        }

        setStatus('processing');
        retryTimer = setTimeout(() => {
          setRetryCount((current) => current + 1);
        }, RECENT_END_RETRY_DELAY_MS);
        return true;
      };

      const scheduleRecentRetry = () => {
        if (!hasRecentEndHint) {
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
        const historyEntry = useSessionHistoryStore.getState().getSession(sessionId);
        const shouldRetryStoredMemories = shouldRetryMemories(artifacts.endedAt || historyEntry?.endedAt);
        const hasStoredMemories = Array.isArray(artifacts.memoryCandidates) && artifacts.memoryCandidates.length > 0;

        if (!hasStoredMemories) {
          const hydratedStoredArtifacts = await hydrateStoredArtifactsWithRecentMemories(
            artifacts,
            sessionId,
            historyEntry,
          );

          if ((hydratedStoredArtifacts?.memoryCandidates?.length ?? 0) > 0) {
            if (hasRecentEndHint) {
              clearRecentSessionEndHint();
            }
            setArtifacts(sessionId, hydratedStoredArtifacts);
          } else if (scheduleMemoryRetry(shouldRetryStoredMemories)) {
            return;
          } else if (hasRecentEndHint) {
            clearRecentSessionEndHint();
          }
        } else if (hasRecentEndHint) {
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

          const hydratedArtifactsPayload = await hydratePayloadWithRecentMemories(artifactsPayload, sessionId);
          const mapped = mapBackendArtifactsToRecapV1(hydratedArtifactsPayload, sessionId);

          if (mapped) {
            const hasMappedMemories = (mapped.memoryCandidates?.length ?? 0) > 0;
            const shouldRetryFetchedMemories = shouldRetryMemories(mapped.endedAt || (typeof data?.ended_at === 'string' ? data.ended_at : null));

            if (!hasMappedMemories && shouldRetryFetchedMemories) {
              setArtifacts(sessionId, mapped);

              if (scheduleMemoryRetry(shouldRetryFetchedMemories)) {
                return;
              }
            }

            if (hasRecentEndHint) {
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
