import { useEffect, useState, useCallback } from 'react';

import { mockRecapArtifacts } from '../../components/recap/mockData';
import { mapBackendArtifactsToRecapV1 } from '../../lib/artifacts-adapter';
import { logger } from '../../lib/error-logger';
import {
  applyRecapPageStatus,
  applyRecapRequestObservation,
  createInitialRecapTelemetryState,
  getResponseShapeKeys,
  inferAbortReason,
  safeErrorMessage,
  type MemoryRecentEmptyReason,
  type MemoryRecentSource,
  type RecapRequestKind,
  type RecapRequestObservation,
  type RecapTelemetryState,
} from '../../lib/recap-telemetry-report';
import type { RecapArtifactsV1 } from '../../lib/recap-types';
import { clearRecentSessionEndHint, getRecentSessionEndHint } from '../../lib/recent-session-end';
import { useSessionHistoryStore } from '../../stores/session-history-store';

const RECENT_END_RETRY_DELAY_MS = 1500;
const RECENT_END_MAX_RETRIES = 6;
const RECENT_END_CONTEXT_WINDOW_MS = 2 * 60 * 1000;
const RECENT_MEMORIES_FETCH_TIMEOUT_MS = 15000;

type RecentMemoryStatus = 'pending_review' | 'approved';

export type RecapPageStatus = 'loading' | 'ready' | 'processing' | 'reviewed' | 'unavailable' | 'not_found';

interface UseRecapArtifactsLoaderParams {
  sessionId: string;
  artifacts: RecapArtifactsV1 | null;
  setArtifacts: (sessionId: string, artifacts: RecapArtifactsV1) => void;
}

interface UseRecapArtifactsLoaderResult {
  status: RecapPageStatus;
  reload: () => void;
  telemetry: RecapTelemetryState;
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
  count?: number;
  source?: string;
  candidate_count?: number;
  session_id_received?: boolean;
  next_proxy_forwarded_session_id?: boolean;
  gateway_received_session_id?: boolean;
  empty_reason?: string;
  trace_id?: string;
  debug?: Record<string, unknown>;
}

type RecapTelemetryRecorder = (observation: RecapRequestObservation) => void;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeMemoryRecentSource(value: string | null): MemoryRecentSource {
  switch (value) {
    case 'local_review_overlay':
    case 'global_hydration':
    case 'mem0':
    case 'none':
    case 'error':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeEmptyReason(value: string | null): MemoryRecentEmptyReason {
  switch (value) {
    case 'no_session_candidates':
    case 'no_results':
    case 'filtered_out':
      return value;
    default:
      return 'unknown';
  }
}

function getMemoryRecentDiagnostics(payload: RecentMemoriesResponse | null): {
  candidateCount: number;
  source: MemoryRecentSource;
  emptyReason: MemoryRecentEmptyReason;
  nextProxyForwardedSessionId: boolean;
  gatewayReceivedSessionId: boolean;
  safeTraceId: string | null;
} {
  const root = asRecord(payload);
  const debug = asRecord(root?.debug);
  const memories = Array.isArray(payload?.memories) ? payload.memories : [];
  const candidateCount =
    readNumber(root, 'candidate_count')
    ?? readNumber(debug, 'candidate_count')
    ?? readNumber(root, 'count')
    ?? memories.length;
  const source = normalizeMemoryRecentSource(readString(root, 'source') ?? readString(debug, 'source'));
  const emptyReason = normalizeEmptyReason(readString(root, 'empty_reason') ?? readString(debug, 'empty_reason'));

  return {
    candidateCount,
    source: source === 'unknown' && candidateCount === 0 ? 'none' : source,
    emptyReason: emptyReason === 'unknown' && candidateCount === 0 ? 'no_results' : emptyReason,
    nextProxyForwardedSessionId:
      readBoolean(root, 'next_proxy_forwarded_session_id')
      ?? readBoolean(debug, 'next_proxy_forwarded_session_id')
      ?? false,
    gatewayReceivedSessionId:
      readBoolean(root, 'gateway_received_session_id')
      ?? readBoolean(debug, 'gateway_received_session_id')
      ?? readBoolean(root, 'session_id_received')
      ?? false,
    safeTraceId: readString(root, 'trace_id') ?? readString(debug, 'trace_id'),
  };
}

function buildRecentMemoriesSearchParams(
  payload: Record<string, unknown>,
  sessionId: string,
  status: RecentMemoryStatus,
): URLSearchParams {
  const params = new URLSearchParams({
    status,
    session_id: sessionId,
  });

  if (typeof payload.started_at === 'string') {
    params.set('started_at', payload.started_at);
  }

  if (typeof payload.ended_at === 'string') {
    params.set('ended_at', payload.ended_at);
  }

  return params;
}

async function fetchSessionRecentMemories(
  payload: Record<string, unknown> | null,
  sessionId: string,
  status: RecentMemoryStatus,
  recordTelemetry?: RecapTelemetryRecorder,
): Promise<NonNullable<RecentMemoriesResponse['memories']>> {
  if (!payload) {
    return [];
  }

  const params = buildRecentMemoriesSearchParams(payload, sessionId, status);
  const frontendPath = `/api/memory/recent?${params.toString()}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const timeoutMs = RECENT_MEMORIES_FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const kind: RecapRequestKind = status === 'approved'
    ? 'memory_recent_approved'
    : 'memory_recent_pending_review';

  try {
    const response = await fetch(frontendPath, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
    });

    if (!response.ok) {
      recordTelemetry?.({
        kind,
        frontendPath,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status: response.status,
        ok: false,
        aborted: false,
        abortReason: null,
        timeoutMs,
        responseShapeKeys: [],
        sessionIdIncluded: params.has('session_id'),
        errorCode: `http_${response.status}`,
      });
      return [];
    }

    const recentMemories = await response.json() as RecentMemoriesResponse;
    const diagnostics = getMemoryRecentDiagnostics(recentMemories);
    recordTelemetry?.({
      kind,
      frontendPath,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      status: response.status,
      ok: response.ok,
      aborted: false,
      abortReason: null,
      timeoutMs,
      responseShapeKeys: getResponseShapeKeys(recentMemories),
      candidateCount: diagnostics.candidateCount,
      source: diagnostics.source,
      emptyReason: diagnostics.emptyReason,
      sessionIdIncluded: params.has('session_id'),
      nextProxyForwardedSessionId: diagnostics.nextProxyForwardedSessionId,
      gatewayReceivedSessionId: diagnostics.gatewayReceivedSessionId,
      safeTraceId: diagnostics.safeTraceId,
    });
    return Array.isArray(recentMemories.memories)
      ? recentMemories.memories
      : [];
  } catch (error) {
    const abortReason = inferAbortReason(error, signal);
    const aborted = signal.aborted || abortReason !== null;
    recordTelemetry?.({
      kind,
      frontendPath,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      status: null,
      ok: false,
      aborted,
      abortReason,
      timeoutMs,
      responseShapeKeys: [],
      errorCode: aborted ? abortReason ?? 'aborted' : 'fetch_error',
      errorSafeMessage: safeErrorMessage(error),
      sessionIdIncluded: params.has('session_id'),
      nextProxyForwardedSessionId: false,
      gatewayReceivedSessionId: false,
    });
    logger.logError(error, {
      component: 'Recap',
      action: 'fetch_recent_memories',
      memoryStatus: status,
    });
    return [];
  }
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
    thread_id: artifacts.threadId,
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
    builder_artifact: artifacts.builderArtifact,
    status: artifacts.status,
  };
}

export async function hydrateStoredArtifactsWithRecentMemories(
  artifacts: RecapArtifactsV1,
  sessionId: string,
  historyEntry?: { startedAt?: string; endedAt?: string },
  recordTelemetry?: RecapTelemetryRecorder,
): Promise<RecapArtifactsV1 | null> {
  const hydratedStoredPayload = await hydratePayloadWithRecentMemories(
    {
      ...buildArtifactsPayloadFromStore(artifacts, sessionId),
      started_at: artifacts.startedAt || historyEntry?.startedAt,
      ended_at: artifacts.endedAt || historyEntry?.endedAt,
    },
    sessionId,
    recordTelemetry,
  );

  return mapBackendArtifactsToRecapV1(hydratedStoredPayload, sessionId);
}

async function hydratePayloadWithRecentMemories(
  payload: Record<string, unknown> | null,
  sessionId: string,
  recordTelemetry?: RecapTelemetryRecorder,
): Promise<Record<string, unknown> | null> {
  if (!payload) {
    return null;
  }

  if (Array.isArray(payload.memory_candidates) && payload.memory_candidates.length > 0) {
    return payload;
  }

  const recentMemories = await fetchSessionRecentMemories(payload, sessionId, 'pending_review', recordTelemetry);
  if (recentMemories.length === 0) {
    return payload;
  }

  return {
    ...payload,
    memory_candidates: recentMemories.map((memory) => ({
      ...(memory.id ? { id: memory.id } : {}),
      text: memory.text,
      category: memory.category,
      ...(memory.created_at ? { created_at: memory.created_at } : {}),
      ...(typeof memory.confidence === 'number' ? { confidence: memory.confidence } : {}),
      ...(memory.reason ? { reason: memory.reason } : {}),
    })),
  };
}

async function sessionHasReviewedMemories(
  payload: Record<string, unknown> | null,
  sessionId: string,
  recordTelemetry?: RecapTelemetryRecorder,
): Promise<boolean> {
  const reviewedMemories = await fetchSessionRecentMemories(payload, sessionId, 'approved', recordTelemetry);
  return reviewedMemories.length > 0;
}

export function useRecapArtifactsLoader({
  sessionId,
  artifacts,
  setArtifacts,
}: UseRecapArtifactsLoaderParams): UseRecapArtifactsLoaderResult {
  const [status, setStatus] = useState<RecapPageStatus>('loading');
  const [retryCount, setRetryCount] = useState(0);
  const [telemetry, setTelemetry] = useState<RecapTelemetryState>(() =>
    createInitialRecapTelemetryState({ sessionId })
  );

  const recordTelemetry = useCallback<RecapTelemetryRecorder>((observation) => {
    setTelemetry((current) => applyRecapRequestObservation(current, observation));
  }, []);

  const setObservedStatus = useCallback((nextStatus: RecapPageStatus) => {
    setStatus(nextStatus);
    setTelemetry((current) => applyRecapPageStatus(current, nextStatus));
  }, []);

  useEffect(() => {
    setTelemetry(createInitialRecapTelemetryState({ sessionId }));
  }, [sessionId]);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const loadArtifacts = async () => {
      setObservedStatus('loading');

      const recentEndHint = getRecentSessionEndHint();
      const hasRecentEndHint = recentEndHint?.sessionId === sessionId;

      const shouldRetryMemories = (endedAt: string | null | undefined) => {
        return hasRecentEndHint || wasEndedRecently(endedAt);
      };

      const scheduleMemoryRetry = (enabled: boolean) => {
        if (!enabled || retryCount >= RECENT_END_MAX_RETRIES) {
          return false;
        }

        setObservedStatus('processing');
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
          setObservedStatus('unavailable');
          return true;
        }

        setObservedStatus('processing');
        retryTimer = setTimeout(() => {
          setRetryCount((current) => current + 1);
        }, RECENT_END_RETRY_DELAY_MS);
        return true;
      };

      if (artifacts) {
        const historyEntry = useSessionHistoryStore.getState().getSession(sessionId);
        const shouldRetryStoredMemories = shouldRetryMemories(artifacts.endedAt || historyEntry?.endedAt);
        const hasStoredMemories = Array.isArray(artifacts.memoryCandidates) && artifacts.memoryCandidates.length > 0;
        const storedPayload = {
          ...buildArtifactsPayloadFromStore(artifacts, sessionId),
          started_at: artifacts.startedAt || historyEntry?.startedAt,
          ended_at: artifacts.endedAt || historyEntry?.endedAt,
        };

        if (!hasStoredMemories) {
          const hydratedStoredArtifacts = await hydrateStoredArtifactsWithRecentMemories(
            artifacts,
            sessionId,
            historyEntry,
            recordTelemetry,
          );

          if ((hydratedStoredArtifacts?.memoryCandidates?.length ?? 0) > 0) {
            if (hasRecentEndHint) {
              clearRecentSessionEndHint();
            }
            setArtifacts(sessionId, hydratedStoredArtifacts);
          } else if (await sessionHasReviewedMemories(storedPayload, sessionId, recordTelemetry)) {
            if (hasRecentEndHint) {
              clearRecentSessionEndHint();
            }
            useSessionHistoryStore.getState().markRecapViewed(sessionId);
            setObservedStatus('reviewed');
            return;
          } else if (scheduleMemoryRetry(shouldRetryStoredMemories)) {
            return;
          } else if (hasRecentEndHint) {
            clearRecentSessionEndHint();
          }
        } else if (hasRecentEndHint) {
          clearRecentSessionEndHint();
        }

        useSessionHistoryStore.getState().markRecapViewed(sessionId);
        setObservedStatus('ready');
        return;
      }

      const recapFrontendPath = `/api/sophia/sessions/${sessionId}/recap`;
      const recapStartedAt = new Date().toISOString();
      const recapStartedMs = Date.now();
      const recapTimeoutMs = 5000;
      let recapSignal: AbortSignal | null = null;

      try {
        const signal = AbortSignal.timeout(recapTimeoutMs);
        recapSignal = signal;
        const response = await fetch(recapFrontendPath, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          signal,
        });

        if (response.ok) {
          const data = await response.json() as Record<string, unknown>;
          recordTelemetry({
            kind: 'recap',
            frontendPath: recapFrontendPath,
            startedAt: recapStartedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - recapStartedMs,
            status: response.status,
            ok: true,
            aborted: false,
            abortReason: null,
            timeoutMs: recapTimeoutMs,
            responseShapeKeys: getResponseShapeKeys(data),
          });

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

          // Backstop for sparse recap envelopes (e.g. Telegram-originated
          // sessions where ``recap_artifacts`` is null and there are no
          // top-level takeaway/reflection/memory_candidates). Without this,
          // ``mapBackendArtifactsToRecapV1`` early-null-returns and the
          // page falls into the empty state even though the gateway DID
          // return a valid 200 with session metadata. Synthesizing an
          // empty artifactsPayload lets the hydration step pull pending
          // Mem0 candidates from /api/memory/recent and populate the page.
          const sessionMetadataOnly = !nestedArtifacts && !hasTopLevelArtifacts && data
            ? {
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
            : fallbackTopLevelArtifacts ?? sessionMetadataOnly;

          const hydratedArtifactsPayload = await hydratePayloadWithRecentMemories(artifactsPayload, sessionId, recordTelemetry);
          const mapped = mapBackendArtifactsToRecapV1(hydratedArtifactsPayload, sessionId);

          if (mapped) {
            const hasMappedMemories = (mapped.memoryCandidates?.length ?? 0) > 0;
            const shouldRetryFetchedMemories = shouldRetryMemories(mapped.endedAt || (typeof data?.ended_at === 'string' ? data.ended_at : null));

            if (!hasMappedMemories && shouldRetryFetchedMemories) {
              // Freshly ended sessions can briefly return an envelope with no
              // artifacts while the offline pipeline is still writing. Always
              // retry first in this window so we do not prematurely mark the
              // recap as reviewed from stale approved memories.
              setArtifacts(sessionId, mapped);

              if (scheduleMemoryRetry(shouldRetryFetchedMemories)) {
                return;
              }
            } else if (!hasMappedMemories && await sessionHasReviewedMemories(artifactsPayload, sessionId, recordTelemetry)) {
              if (hasRecentEndHint) {
                clearRecentSessionEndHint();
              }
              setArtifacts(sessionId, mapped);
              useSessionHistoryStore.getState().markRecapViewed(sessionId);
              setObservedStatus('reviewed');
              return;
            }

            if (hasRecentEndHint) {
              clearRecentSessionEndHint();
            }
            setArtifacts(sessionId, mapped);
            useSessionHistoryStore.getState().markRecapViewed(sessionId);
            setObservedStatus('ready');
            return;
          }

          if (scheduleRecentRetry()) {
            return;
          }

          setObservedStatus('processing');
          return;
        }

        recordTelemetry({
          kind: 'recap',
          frontendPath: recapFrontendPath,
          startedAt: recapStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - recapStartedMs,
          status: response.status,
          ok: false,
          aborted: false,
          abortReason: null,
          timeoutMs: recapTimeoutMs,
          responseShapeKeys: [],
          errorCode: `http_${response.status}`,
        });

        if (response.status === 404) {
          if (scheduleRecentRetry()) {
            return;
          }

          setObservedStatus('not_found');
          return;
        }
      } catch (error) {
        const abortReason = inferAbortReason(error, recapSignal);
        recordTelemetry({
          kind: 'recap',
          frontendPath: recapFrontendPath,
          startedAt: recapStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - recapStartedMs,
          status: null,
          ok: false,
          aborted: abortReason !== null,
          abortReason,
          timeoutMs: recapTimeoutMs,
          responseShapeKeys: [],
          errorCode: abortReason ?? 'fetch_error',
          errorSafeMessage: safeErrorMessage(error),
        });
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
        setObservedStatus('ready');
        return;
      }

      setObservedStatus('unavailable');
    };

    void loadArtifacts();

    return () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
    };
  }, [sessionId, artifacts, setArtifacts, retryCount, recordTelemetry, setObservedStatus]);

  const reload = useCallback(() => {
    setStatus('loading');
    window.location.reload();
  }, []);

  return {
    status,
    reload,
    telemetry,
  };
}
