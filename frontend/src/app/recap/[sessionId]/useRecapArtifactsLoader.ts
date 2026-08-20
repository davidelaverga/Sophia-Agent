import { useEffect, useState, useCallback } from 'react';

import { mockRecapArtifacts } from '../../components/recap/mockData';
import { mapBackendArtifactsToRecapV1 } from '../../lib/artifacts-adapter';
import { logger } from '../../lib/error-logger';
import {
  applyRecapPageStatus,
  applyMemoryRecentNotRequestedReason,
  applyRecapRequestObservation,
  createInitialRecapTelemetryState,
  getResponseShapeKeys,
  inferAbortReason,
  readLastSessionTelemetrySnapshot,
  safeErrorMessage,
  type LastSessionTelemetrySnapshot,
  type MemoryRecentEmptyReason,
  type MemoryRecentNotRequestedReason,
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
  unavailable?: boolean;
  trace_id?: string;
  debug?: Record<string, unknown>;
}

type RecapTelemetryRecorder = (observation: RecapRequestObservation) => void;
type MemoryRecentSkipRecorder = (reason: NonNullable<MemoryRecentNotRequestedReason>) => void;

interface MemoryRecentDiagnostics {
  candidateCount: number;
  source: MemoryRecentSource;
  emptyReason: MemoryRecentEmptyReason;
  unavailable: boolean;
  terminal: boolean;
  nextProxyForwardedSessionId: boolean;
  gatewayReceivedSessionId: boolean;
  safeTraceId: string | null;
}

interface RecentMemoriesFetchResult {
  memories: NonNullable<RecentMemoriesResponse['memories']>;
  ok: boolean;
  unavailable: boolean;
  terminal: boolean;
  candidateCount: number;
  source: MemoryRecentSource;
  emptyReason: MemoryRecentEmptyReason;
  errorCode: string | null;
}

interface HydratedPayloadResult {
  payload: Record<string, unknown> | null;
  memoryRecent: RecentMemoriesFetchResult | null;
}

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

function getMemoryRecentDiagnostics(payload: RecentMemoriesResponse | null): MemoryRecentDiagnostics {
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
  const hasExplicitEmptyReason = emptyReason !== 'unknown';
  const unavailable =
    readBoolean(root, 'unavailable')
    ?? readBoolean(debug, 'unavailable')
    ?? false;
  const normalizedSource = source === 'unknown' && candidateCount === 0 ? 'none' : source;
  const normalizedEmptyReason = emptyReason === 'unknown' && candidateCount === 0 ? 'no_results' : emptyReason;
  const terminal = !unavailable && (
    candidateCount > 0
    || (hasExplicitEmptyReason && (
      normalizedEmptyReason === 'no_session_candidates'
      || normalizedEmptyReason === 'no_results'
      || normalizedEmptyReason === 'filtered_out'
    ))
  );

  return {
    candidateCount,
    source: normalizedSource,
    emptyReason: normalizedEmptyReason,
    unavailable,
    terminal,
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
): Promise<RecentMemoriesFetchResult> {
  if (!payload) {
    return {
      memories: [],
      ok: false,
      unavailable: false,
      terminal: false,
      candidateCount: 0,
      source: 'unknown',
      emptyReason: 'unknown',
      errorCode: 'missing_payload',
    };
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
      const errorCode = `http_${response.status}`;
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
        errorCode,
        unavailable: true,
        terminal: true,
      });
      return {
        memories: [],
        ok: false,
        unavailable: true,
        terminal: true,
        candidateCount: 0,
        source: 'error',
        emptyReason: 'unknown',
        errorCode,
      };
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
      unavailable: diagnostics.unavailable,
      terminal: diagnostics.terminal,
      sessionIdIncluded: params.has('session_id'),
      nextProxyForwardedSessionId: diagnostics.nextProxyForwardedSessionId,
      gatewayReceivedSessionId: diagnostics.gatewayReceivedSessionId,
      safeTraceId: diagnostics.safeTraceId,
    });
    const memories = Array.isArray(recentMemories.memories)
      ? recentMemories.memories
      : [];
    return {
      memories,
      ok: response.ok && !diagnostics.unavailable,
      unavailable: diagnostics.unavailable,
      terminal: diagnostics.terminal,
      candidateCount: diagnostics.candidateCount,
      source: diagnostics.source,
      emptyReason: diagnostics.emptyReason,
      errorCode: diagnostics.unavailable ? 'unavailable' : null,
    };
  } catch (error) {
    const abortReason = inferAbortReason(error, signal);
    const aborted = signal.aborted || abortReason !== null;
    const errorCode = aborted ? abortReason ?? 'aborted' : 'fetch_error';
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
      errorCode,
      errorSafeMessage: safeErrorMessage(error),
      sessionIdIncluded: params.has('session_id'),
      nextProxyForwardedSessionId: false,
      gatewayReceivedSessionId: false,
      unavailable: true,
      terminal: true,
    });
    logger.logError(error, {
      component: 'Recap',
      action: 'fetch_recent_memories',
      memoryStatus: status,
    });
    return {
      memories: [],
      ok: false,
      unavailable: true,
      terminal: true,
      candidateCount: 0,
      source: 'error',
      emptyReason: 'unknown',
      errorCode,
    };
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

function isTerminalEmptyMemoryRecent(result: RecentMemoriesFetchResult | null): boolean {
  return Boolean(
    result
    && result.terminal
    && result.ok
    && !result.unavailable
    && result.candidateCount === 0
    && result.memories.length === 0
    && (
      result.emptyReason === 'no_session_candidates'
      || result.emptyReason === 'no_results'
      || result.emptyReason === 'filtered_out'
    )
  );
}

function buildEndedSessionMemoryPayload({
  artifacts,
  historyEntry,
  sessionId,
  snapshot,
}: {
  artifacts?: RecapArtifactsV1 | null;
  historyEntry?: { startedAt?: string; endedAt?: string; presetType?: string; contextMode?: string } | null;
  sessionId: string;
  snapshot?: LastSessionTelemetrySnapshot | null;
}): Record<string, unknown> | null {
  if (!sessionId) {
    return null;
  }

  const endedAt = artifacts?.endedAt || historyEntry?.endedAt || snapshot?.endedAt || null;
  if (!endedAt) {
    return null;
  }

  return {
    session_id: sessionId,
    thread_id: artifacts?.threadId || snapshot?.threadId || undefined,
    session_type: artifacts?.sessionType || historyEntry?.presetType || undefined,
    context_mode: artifacts?.contextMode || historyEntry?.contextMode || undefined,
    started_at: artifacts?.startedAt || historyEntry?.startedAt || undefined,
    ended_at: endedAt,
    status: 'ready',
    memory_candidates: [],
  };
}

export async function hydrateStoredArtifactsWithRecentMemories(
  artifacts: RecapArtifactsV1,
  sessionId: string,
  historyEntry?: { startedAt?: string; endedAt?: string },
  recordTelemetry?: RecapTelemetryRecorder,
): Promise<RecapArtifactsV1 | null> {
  const hydratedStored = await hydratePayloadWithRecentMemories(
    {
      ...buildArtifactsPayloadFromStore(artifacts, sessionId),
      started_at: artifacts.startedAt || historyEntry?.startedAt,
      ended_at: artifacts.endedAt || historyEntry?.endedAt,
    },
    sessionId,
    recordTelemetry,
  );

  return mapBackendArtifactsToRecapV1(hydratedStored.payload, sessionId);
}

async function hydratePayloadWithRecentMemories(
  payload: Record<string, unknown> | null,
  sessionId: string,
  recordTelemetry?: RecapTelemetryRecorder,
  recordSkipped?: MemoryRecentSkipRecorder,
): Promise<HydratedPayloadResult> {
  if (!payload) {
    recordSkipped?.('waiting_for_required_recap_status');
    return {
      payload: null,
      memoryRecent: null,
    };
  }

  if (Array.isArray(payload.memory_candidates) && payload.memory_candidates.length > 0) {
    recordSkipped?.('already_resolved');
    return {
      payload,
      memoryRecent: null,
    };
  }

  const memoryRecent = await fetchSessionRecentMemories(payload, sessionId, 'pending_review', recordTelemetry);
  if (memoryRecent.memories.length === 0) {
    return {
      payload,
      memoryRecent,
    };
  }

  return {
    payload: {
      ...payload,
      memory_candidates: memoryRecent.memories.map((memory) => ({
        ...(memory.id ? { id: memory.id } : {}),
        text: memory.text,
        category: memory.category,
        ...(memory.created_at ? { created_at: memory.created_at } : {}),
        ...(typeof memory.confidence === 'number' ? { confidence: memory.confidence } : {}),
        ...(memory.reason ? { reason: memory.reason } : {}),
      })),
    },
    memoryRecent,
  };
}

async function sessionHasReviewedMemories(
  payload: Record<string, unknown> | null,
  sessionId: string,
  recordTelemetry?: RecapTelemetryRecorder,
): Promise<boolean> {
  const reviewedMemories = await fetchSessionRecentMemories(payload, sessionId, 'approved', recordTelemetry);
  return reviewedMemories.memories.length > 0;
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

  const recordMemoryRecentSkipped = useCallback<MemoryRecentSkipRecorder>((reason) => {
    setTelemetry((current) => applyMemoryRecentNotRequestedReason(current, reason));
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
      const historyEntry = useSessionHistoryStore.getState().getSession(sessionId);
      const sessionTelemetrySnapshot = readLastSessionTelemetrySnapshot(sessionId);

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
        const endedSessionPayload = buildEndedSessionMemoryPayload({
          artifacts,
          historyEntry,
          sessionId,
          snapshot: sessionTelemetrySnapshot,
        });
        const shouldRetryStoredMemories = shouldRetryMemories(
          artifacts.endedAt || historyEntry?.endedAt || sessionTelemetrySnapshot?.endedAt
        );
        const hasStoredMemories = Array.isArray(artifacts.memoryCandidates) && artifacts.memoryCandidates.length > 0;
        const baseStoredPayload = buildArtifactsPayloadFromStore(artifacts, sessionId);
        const storedPayload = {
          ...baseStoredPayload,
          ...endedSessionPayload,
          takeaway: baseStoredPayload.takeaway,
          reflection_candidate: baseStoredPayload.reflection_candidate,
          memory_candidates: baseStoredPayload.memory_candidates,
          builder_artifact: baseStoredPayload.builder_artifact,
          started_at: artifacts.startedAt || historyEntry?.startedAt || endedSessionPayload?.started_at,
          ended_at: artifacts.endedAt || historyEntry?.endedAt || sessionTelemetrySnapshot?.endedAt,
        };

        if (!hasStoredMemories) {
          const hydratedStored = await hydratePayloadWithRecentMemories(
            storedPayload,
            sessionId,
            recordTelemetry,
            recordMemoryRecentSkipped,
          );
          const hydratedStoredArtifacts = mapBackendArtifactsToRecapV1(hydratedStored.payload, sessionId);

          if ((hydratedStoredArtifacts?.memoryCandidates?.length ?? 0) > 0) {
            if (hasRecentEndHint) {
              clearRecentSessionEndHint();
            }
            setArtifacts(sessionId, hydratedStoredArtifacts);
          } else if (hydratedStored.memoryRecent?.unavailable || (hydratedStored.memoryRecent && !hydratedStored.memoryRecent.ok)) {
            if (hasRecentEndHint) {
              clearRecentSessionEndHint();
            }
            // The store already contains this recap. Replacing it with an
            // equivalent empty hydration changes the `artifacts` dependency
            // and starts this effect again, producing an unbounded request
            // loop while the page appears stuck in its loading state.
            setObservedStatus('unavailable');
            return;
          } else if (isTerminalEmptyMemoryRecent(hydratedStored.memoryRecent)) {
            if (hasRecentEndHint) {
              clearRecentSessionEndHint();
            }
            // A terminal-empty response adds no data to the stored recap.
            // Keep the existing object identity so this effect can settle in
            // `ready` instead of continuously rehydrating the same payload.
            useSessionHistoryStore.getState().markRecapViewed(sessionId);
            setObservedStatus('ready');
            return;
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

          const hydratedArtifacts = await hydratePayloadWithRecentMemories(
            artifactsPayload,
            sessionId,
            recordTelemetry,
            recordMemoryRecentSkipped,
          );
          const mapped = mapBackendArtifactsToRecapV1(hydratedArtifacts.payload, sessionId);

          if (mapped) {
            const hasMappedMemories = (mapped.memoryCandidates?.length ?? 0) > 0;
            const shouldRetryFetchedMemories = shouldRetryMemories(
              mapped.endedAt
              || (typeof data?.ended_at === 'string' ? data.ended_at : null)
              || historyEntry?.endedAt
              || sessionTelemetrySnapshot?.endedAt
            );

            if (!hasMappedMemories && (hydratedArtifacts.memoryRecent?.unavailable || (hydratedArtifacts.memoryRecent && !hydratedArtifacts.memoryRecent.ok))) {
              if (hasRecentEndHint) {
                clearRecentSessionEndHint();
              }
              setArtifacts(sessionId, mapped);
              setObservedStatus('unavailable');
              return;
            }

            if (!hasMappedMemories && isTerminalEmptyMemoryRecent(hydratedArtifacts.memoryRecent)) {
              if (hasRecentEndHint) {
                clearRecentSessionEndHint();
              }
              setArtifacts(sessionId, mapped);
              useSessionHistoryStore.getState().markRecapViewed(sessionId);
              setObservedStatus('ready');
              return;
            }

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

          const endedSessionPayload = buildEndedSessionMemoryPayload({
            historyEntry,
            sessionId,
            snapshot: sessionTelemetrySnapshot,
          });
          if (endedSessionPayload) {
            const hydratedEnded = await hydratePayloadWithRecentMemories(
              endedSessionPayload,
              sessionId,
              recordTelemetry,
              recordMemoryRecentSkipped,
            );
            const endedMapped = mapBackendArtifactsToRecapV1(hydratedEnded.payload, sessionId);
            if (endedMapped && (isTerminalEmptyMemoryRecent(hydratedEnded.memoryRecent) || (endedMapped.memoryCandidates?.length ?? 0) > 0)) {
              if (hasRecentEndHint) {
                clearRecentSessionEndHint();
              }
              setArtifacts(sessionId, endedMapped);
              useSessionHistoryStore.getState().markRecapViewed(sessionId);
              setObservedStatus('ready');
              return;
            }
            if (hydratedEnded.memoryRecent?.unavailable || (hydratedEnded.memoryRecent && !hydratedEnded.memoryRecent.ok)) {
              setObservedStatus('unavailable');
              return;
            }
          }

          if (scheduleRecentRetry()) {
            return;
          }

          recordMemoryRecentSkipped('session_not_ended');
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
          const endedSessionPayload = buildEndedSessionMemoryPayload({
            historyEntry,
            sessionId,
            snapshot: sessionTelemetrySnapshot,
          });
          if (endedSessionPayload) {
            const hydratedEnded = await hydratePayloadWithRecentMemories(
              endedSessionPayload,
              sessionId,
              recordTelemetry,
              recordMemoryRecentSkipped,
            );
            const endedMapped = mapBackendArtifactsToRecapV1(hydratedEnded.payload, sessionId);
            if (endedMapped && (isTerminalEmptyMemoryRecent(hydratedEnded.memoryRecent) || (endedMapped.memoryCandidates?.length ?? 0) > 0)) {
              if (hasRecentEndHint) {
                clearRecentSessionEndHint();
              }
              setArtifacts(sessionId, endedMapped);
              useSessionHistoryStore.getState().markRecapViewed(sessionId);
              setObservedStatus('ready');
              return;
            }
            if (hydratedEnded.memoryRecent?.unavailable || (hydratedEnded.memoryRecent && !hydratedEnded.memoryRecent.ok)) {
              setObservedStatus('unavailable');
              return;
            }
          }

          if (scheduleRecentRetry()) {
            return;
          }

          recordMemoryRecentSkipped('session_not_ended');
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
  }, [sessionId, artifacts, setArtifacts, retryCount, recordTelemetry, recordMemoryRecentSkipped, setObservedStatus]);

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
