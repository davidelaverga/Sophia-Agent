import type { SessionHistoryEntry } from '../stores/session-history-store';

import type { MemoryDecisionState, RecapArtifactsV1 } from './recap-types';
import type { SophiaCaptureSnapshot } from './session-capture';
import type {
  VoiceDeveloperMetrics,
  VoiceTelemetrySummary,
} from './voice-runtime-metrics';

export const RECAP_TELEMETRY_REPORT_VERSION = 1;
export const LAST_SESSION_TELEMETRY_STORAGE_PREFIX = 'sophia:last-session-telemetry:';

export type RecapDebugStatus =
  | 'composing'
  | 'ready'
  | 'no_results'
  | 'error'
  | 'unknown';

export type MemoryRecentSource =
  | 'local_review_overlay'
  | 'global_hydration'
  | 'mem0'
  | 'none'
  | 'unknown'
  | 'error';

export type MemoryRecentEmptyReason =
  | 'no_session_candidates'
  | 'no_results'
  | 'filtered_out'
  | 'unknown';

export type RecapAbortReason = 'timeout' | 'navigation' | 'manual' | 'unknown' | null;

export type MemoryRecentNotRequestedReason =
  | 'missing_session_id'
  | 'session_not_ended'
  | 'disabled_by_status'
  | 'waiting_for_required_recap_status'
  | 'already_resolved'
  | 'already_requested'
  | 'unknown'
  | null;

export type RecapRequestKind =
  | 'recap'
  | 'memory_recent_pending_review'
  | 'memory_recent_approved';

export type RecapRequestObservation = {
  kind: RecapRequestKind;
  frontendPath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: number | null;
  ok: boolean;
  aborted: boolean;
  abortReason: RecapAbortReason;
  timeoutMs: number | null;
  responseShapeKeys: string[];
  errorCode?: string | null;
  errorSafeMessage?: string | null;
  candidateCount?: number | null;
  source?: MemoryRecentSource | null;
  emptyReason?: MemoryRecentEmptyReason | null;
  unavailable?: boolean;
  terminal?: boolean;
  sessionIdIncluded?: boolean;
  nextProxyForwardedSessionId?: boolean;
  gatewayReceivedSessionId?: boolean;
  safeTraceId?: string | null;
};

export type RecapTelemetryState = {
  version: 1;
  sessionId: string;
  route: string;
  createdAt: string;
  updatedAt: string;
  recap: {
    status: RecapDebugStatus;
    statusSource: 'frontend' | 'gateway' | 'file' | 'unknown';
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    pollCount: number;
    lastPollAt: string | null;
    lastPollDurationMs: number | null;
    abortCount: number;
    lastAbortReason: RecapAbortReason;
    errorCode: string | null;
    errorSafeMessage: string | null;
    responseShapeKeys: string[];
    terminalReason: string | null;
  };
  memoryRecent: {
    requested: boolean;
    memoryRecentNotRequestedReason: MemoryRecentNotRequestedReason;
    frontendPath: string | null;
    sessionIdIncluded: boolean;
    nextProxyForwardedSessionId: boolean;
    gatewayReceivedSessionId: boolean;
    status: number | null;
    durationMs: number | null;
    aborted: boolean;
    abortMs: number | null;
    abortCount: number;
    lastAbortReason: RecapAbortReason;
    candidateCount: number | null;
    source: MemoryRecentSource;
    emptyReason: MemoryRecentEmptyReason;
    unavailable: boolean;
    terminal: boolean;
    responseShapeKeys: string[];
    pollCount: number;
    lastPollAt: string | null;
    lastPollDurationMs: number | null;
    safeTraceId: string | null;
  };
  requests: RecapRequestObservation[];
};

export type LastSessionTelemetrySnapshot = {
  schema: 'sophia-last-session-telemetry-v1';
  capturedAt: string;
  source: 'session-ui';
  sessionId: string;
  threadId: string | null;
  runId: string | null;
  status: 'active' | 'ended' | 'unknown';
  endedAt: string | null;
  messageCount: number;
  stage: string;
  runtime: 'legacy_cascade' | 'gemini_live';
  runtimeSource: string;
  counts: {
    events: number;
    turns: number;
    userTranscripts: number;
    assistantTranscripts: number;
    artifacts: number;
    artifactPublicEventCount: number;
    artifactRuntimeIngestCount: number;
    artifactRenderedCount: number;
    diagnostics: number;
    builderEvents: number;
  };
  voiceSummary: {
    healthLevel: string;
    bottleneckKind: string;
    bottleneckLevel: string;
    regressionKeys: string[];
    sessionReadyMs: number | null;
    committedResponseMs: number | null;
    responseWindowMs: number | null;
  };
  gemini: {
    sessionId: string | null;
    transport: string | null;
    connectionState: string | null;
    websocketState: string | null;
    relayStatus: string | null;
    publicSseState: string | null;
    setupComplete: boolean;
    providerEventCount: number;
    outputAudioEventCount: number;
    toolCallCount: number;
    toolResponseCount: number;
    toolRejectionCount: number;
    artifactToolCallCount: number;
    builderToolCallCount: number;
    publicTurnCount: number;
    artifactCount: number;
    lastProviderEventAt: string | null;
    lastToolAt: string | null;
    lastRelayTraceAt: string | null;
    lastAssistantTranscriptAt: string | null;
    streamUrlPresent: boolean;
    websocketUrlPresent: boolean;
    relayUrlPresent: boolean;
  } | null;
};

export type RecapTelemetryReport = {
  reportType: 'recap-telemetry-report';
  version: 1;
  source: 'recap-ui';
  exportedAt: string;
  route: string;
  session: {
    sessionId: string;
    threadId: string | null;
    runId: string | null;
    status: 'active' | 'ended' | 'unknown';
    endedAt: string | null;
    messageCount: number;
    sessionTelemetrySnapshotAvailable: boolean;
  };
  recap: {
    status: RecapDebugStatus;
    statusSource: 'frontend' | 'gateway' | 'file' | 'unknown';
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    pollCount: number;
    lastPollAt: string | null;
    lastPollDurationMs: number | null;
    abortCount: number;
    lastAbortReason: RecapAbortReason;
    errorCode: string | null;
    errorSafeMessage: string | null;
    terminalReason: string | null;
  };
  memoryRecent: {
    requested: boolean;
    memoryRecentNotRequestedReason: MemoryRecentNotRequestedReason;
    frontendPath: string | null;
    sessionIdIncluded: boolean;
    nextProxyForwardedSessionId: boolean;
    gatewayReceivedSessionId: boolean;
    status: number | null;
    durationMs: number | null;
    aborted: boolean;
    abortMs: number | null;
    abortCount: number;
    lastAbortReason: RecapAbortReason;
    candidateCount: number;
    source: MemoryRecentSource;
    emptyReason: MemoryRecentEmptyReason;
    unavailable: boolean;
    terminal: boolean;
    responseShapeKeys: string[];
  };
  artifacts: {
    takeaway: 'ready' | 'waiting' | 'error' | 'unknown';
    reflection: 'ready' | 'waiting' | 'error' | 'unknown';
    memories: 'ready' | 'waiting' | 'no_results' | 'error' | 'unknown';
    memoryCommitStatus: 'idle' | 'running' | 'ready' | 'error' | 'unknown';
    artifactCount: number;
    memoryCandidateCount: number;
    reviewedDecisionCount: number;
    approvedDecisionCount: number;
    discardedDecisionCount: number;
  };
  diagnostics: {
    regressionKeys: string[];
    warnings: string[];
    safeTraceIds: string[];
    notes: string[];
  };
  sessionTelemetrySnapshot: LastSessionTelemetrySnapshot | null;
  redaction: {
    rawMemoryTextIncluded: false;
    authHeadersIncluded: false;
    cookiesIncluded: false;
    providerTokensIncluded: false;
  };
};

type BuildRecapTelemetryReportParams = {
  sessionId: string;
  route: string;
  pageStatus: string;
  telemetry: RecapTelemetryState;
  artifacts: RecapArtifactsV1 | null | undefined;
  decisions: MemoryDecisionState[];
  memoryCommitStatus: string | null | undefined;
  historyEntry?: SessionHistoryEntry | null;
  exportedAt?: string;
  sessionTelemetrySnapshot?: LastSessionTelemetrySnapshot | null;
};

export function createInitialRecapTelemetryState({
  now = new Date().toISOString(),
  route,
  sessionId,
}: {
  now?: string;
  route?: string;
  sessionId: string;
}): RecapTelemetryState {
  return {
    version: 1,
    sessionId,
    route: route || `/recap/${sessionId}`,
    createdAt: now,
    updatedAt: now,
    recap: {
      status: 'unknown',
      statusSource: 'unknown',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      pollCount: 0,
      lastPollAt: null,
      lastPollDurationMs: null,
      abortCount: 0,
      lastAbortReason: null,
      errorCode: null,
      errorSafeMessage: null,
      responseShapeKeys: [],
      terminalReason: null,
    },
    memoryRecent: {
      requested: false,
      memoryRecentNotRequestedReason: 'unknown',
      frontendPath: null,
      sessionIdIncluded: false,
      nextProxyForwardedSessionId: false,
      gatewayReceivedSessionId: false,
      status: null,
      durationMs: null,
      aborted: false,
      abortMs: null,
      abortCount: 0,
      lastAbortReason: null,
      candidateCount: null,
      source: 'unknown',
      emptyReason: 'unknown',
      unavailable: false,
      terminal: false,
      responseShapeKeys: [],
      pollCount: 0,
      lastPollAt: null,
      lastPollDurationMs: null,
      safeTraceId: null,
    },
    requests: [],
  };
}

export function applyRecapPageStatus(
  state: RecapTelemetryState,
  pageStatus: string,
  now = new Date().toISOString(),
): RecapTelemetryState {
  const status = mapPageStatusToRecapDebugStatus(pageStatus);
  const completedAt = isTerminalRecapDebugStatus(status)
    ? state.recap.completedAt ?? now
    : state.recap.completedAt;

  return {
    ...state,
    updatedAt: now,
    recap: {
      ...state.recap,
      status,
      statusSource: 'frontend',
      completedAt,
      durationMs: state.recap.startedAt && completedAt
        ? Math.max(0, Date.parse(completedAt) - Date.parse(state.recap.startedAt))
        : state.recap.durationMs,
    },
  };
}

export function applyMemoryRecentNotRequestedReason(
  state: RecapTelemetryState,
  reason: NonNullable<MemoryRecentNotRequestedReason>,
  now = new Date().toISOString(),
): RecapTelemetryState {
  if (state.memoryRecent.requested) {
    return {
      ...state,
      updatedAt: now,
      memoryRecent: {
        ...state.memoryRecent,
        memoryRecentNotRequestedReason: 'already_requested',
      },
    };
  }

  return {
    ...state,
    updatedAt: now,
    memoryRecent: {
      ...state.memoryRecent,
      memoryRecentNotRequestedReason: reason,
    },
  };
}

export function applyRecapRequestObservation(
  state: RecapTelemetryState,
  observation: RecapRequestObservation,
): RecapTelemetryState {
  const requests = [...state.requests, observation].slice(-20);
  const updatedAt = observation.completedAt;

  if (observation.kind === 'recap') {
    const abortCount = state.recap.abortCount + (observation.aborted ? 1 : 0);
    return {
      ...state,
      updatedAt,
      requests,
      recap: {
        ...state.recap,
        startedAt: state.recap.startedAt ?? observation.startedAt,
        pollCount: state.recap.pollCount + 1,
        lastPollAt: observation.startedAt,
        lastPollDurationMs: observation.durationMs,
        abortCount,
        lastAbortReason: observation.aborted ? observation.abortReason : state.recap.lastAbortReason,
        errorCode: observation.errorCode ?? (observation.ok ? null : state.recap.errorCode),
        errorSafeMessage: observation.errorSafeMessage ?? (observation.ok ? null : state.recap.errorSafeMessage),
        responseShapeKeys: observation.responseShapeKeys,
      },
    };
  }

  if (observation.kind === 'memory_recent_approved' && state.memoryRecent.requested) {
    return {
      ...state,
      updatedAt,
      requests,
    };
  }

  const candidateCount = typeof observation.candidateCount === 'number'
    ? observation.candidateCount
    : state.memoryRecent.candidateCount;
  const abortCount = state.memoryRecent.abortCount + (observation.aborted ? 1 : 0);
  const unavailable = Boolean(observation.unavailable);
  const terminal = Boolean(observation.terminal);
  const emptyReason = observation.emptyReason ?? state.memoryRecent.emptyReason;
  const terminalReason = terminal && candidateCount === 0 && emptyReason !== 'unknown'
    ? emptyReason
    : state.recap.terminalReason;

  return {
    ...state,
    updatedAt,
    requests,
    recap: {
      ...state.recap,
      terminalReason,
    },
    memoryRecent: {
      ...state.memoryRecent,
      requested: true,
      memoryRecentNotRequestedReason: null,
      frontendPath: observation.frontendPath,
      sessionIdIncluded: Boolean(observation.sessionIdIncluded),
      nextProxyForwardedSessionId: Boolean(observation.nextProxyForwardedSessionId),
      gatewayReceivedSessionId: Boolean(observation.gatewayReceivedSessionId),
      status: observation.status,
      durationMs: observation.durationMs,
      aborted: observation.aborted,
      abortMs: observation.aborted ? observation.durationMs : null,
      abortCount,
      lastAbortReason: observation.aborted ? observation.abortReason : state.memoryRecent.lastAbortReason,
      candidateCount,
      source: observation.source ?? state.memoryRecent.source,
      emptyReason,
      unavailable,
      terminal,
      responseShapeKeys: observation.responseShapeKeys,
      pollCount: state.memoryRecent.pollCount + 1,
      lastPollAt: observation.startedAt,
      lastPollDurationMs: observation.durationMs,
      safeTraceId: observation.safeTraceId ?? state.memoryRecent.safeTraceId,
    },
  };
}

export function buildRecapTelemetryReport({
  artifacts,
  decisions,
  exportedAt = new Date().toISOString(),
  historyEntry,
  memoryCommitStatus,
  pageStatus,
  route,
  sessionId,
  sessionTelemetrySnapshot = readLastSessionTelemetrySnapshot(sessionId),
  telemetry,
}: BuildRecapTelemetryReportParams): RecapTelemetryReport {
  const memoryCandidateCount = artifacts?.memoryCandidates?.length ?? 0;
  const recapStatus = mapPageStatusToRecapDebugStatus(pageStatus, memoryCandidateCount);
  const isError = recapStatus === 'error';
  const snapshotMatches = sessionTelemetrySnapshot?.sessionId === sessionId;
  const effectiveSnapshot = snapshotMatches ? sessionTelemetrySnapshot : null;
  const sessionStatus = effectiveSnapshot?.status
    ?? (historyEntry?.endedAt || artifacts?.endedAt ? 'ended' : 'unknown');
  const endedAt = effectiveSnapshot?.endedAt
    ?? historyEntry?.endedAt
    ?? artifacts?.endedAt
    ?? null;
  const memoryStatus = classifyMemoryArtifactsStatus(recapStatus, memoryCandidateCount);
  const warnings = buildWarnings(telemetry, effectiveSnapshot);
  const traceIds = [
    telemetry.memoryRecent.safeTraceId,
    ...telemetry.requests.map((request) => request.safeTraceId ?? null),
  ].filter((value, index, values): value is string => (
    typeof value === 'string' && value.trim().length > 0 && values.indexOf(value) === index
  ));

  return {
    reportType: 'recap-telemetry-report',
    version: RECAP_TELEMETRY_REPORT_VERSION,
    source: 'recap-ui',
    exportedAt,
    route,
    session: {
      sessionId,
      threadId: effectiveSnapshot?.threadId ?? artifacts?.threadId ?? null,
      runId: effectiveSnapshot?.runId ?? null,
      status: sessionStatus,
      endedAt,
      messageCount: effectiveSnapshot?.messageCount ?? historyEntry?.messageCount ?? 0,
      sessionTelemetrySnapshotAvailable: effectiveSnapshot !== null,
    },
    recap: {
      status: recapStatus,
      statusSource: telemetry.recap.statusSource,
      startedAt: telemetry.recap.startedAt,
      completedAt: isTerminalRecapDebugStatus(recapStatus)
        ? telemetry.recap.completedAt ?? exportedAt
        : telemetry.recap.completedAt,
      durationMs: telemetry.recap.durationMs,
      pollCount: telemetry.recap.pollCount,
      lastPollAt: telemetry.recap.lastPollAt,
      lastPollDurationMs: telemetry.recap.lastPollDurationMs,
      abortCount: telemetry.recap.abortCount,
      lastAbortReason: telemetry.recap.lastAbortReason,
      errorCode: isError ? telemetry.recap.errorCode ?? pageStatus : telemetry.recap.errorCode,
      errorSafeMessage: isError ? telemetry.recap.errorSafeMessage : telemetry.recap.errorSafeMessage,
      terminalReason: telemetry.recap.terminalReason,
    },
    memoryRecent: {
      requested: telemetry.memoryRecent.requested,
      memoryRecentNotRequestedReason: telemetry.memoryRecent.memoryRecentNotRequestedReason,
      frontendPath: telemetry.memoryRecent.frontendPath,
      sessionIdIncluded: telemetry.memoryRecent.sessionIdIncluded,
      nextProxyForwardedSessionId: telemetry.memoryRecent.nextProxyForwardedSessionId,
      gatewayReceivedSessionId: telemetry.memoryRecent.gatewayReceivedSessionId,
      status: telemetry.memoryRecent.status,
      durationMs: telemetry.memoryRecent.durationMs,
      aborted: telemetry.memoryRecent.aborted,
      abortMs: telemetry.memoryRecent.abortMs,
      abortCount: telemetry.memoryRecent.abortCount,
      lastAbortReason: telemetry.memoryRecent.lastAbortReason,
      candidateCount: telemetry.memoryRecent.candidateCount ?? memoryCandidateCount,
      source: telemetry.memoryRecent.source,
      emptyReason: telemetry.memoryRecent.emptyReason,
      unavailable: telemetry.memoryRecent.unavailable,
      terminal: telemetry.memoryRecent.terminal,
      responseShapeKeys: telemetry.memoryRecent.responseShapeKeys,
    },
    artifacts: {
      takeaway: classifyArtifactFieldStatus(artifacts?.takeaway, recapStatus),
      reflection: classifyArtifactFieldStatus(artifacts?.reflectionCandidate?.prompt, recapStatus),
      memories: memoryStatus,
      memoryCommitStatus: normalizeCommitStatus(memoryCommitStatus),
      artifactCount: countReadyArtifacts(artifacts),
      memoryCandidateCount,
      reviewedDecisionCount: decisions.filter((decision) => decision.decision !== 'idle').length,
      approvedDecisionCount: decisions.filter((decision) => decision.decision === 'approved' || decision.decision === 'edited').length,
      discardedDecisionCount: decisions.filter((decision) => decision.decision === 'discarded').length,
    },
    diagnostics: {
      regressionKeys: effectiveSnapshot?.voiceSummary.regressionKeys ?? [],
      warnings,
      safeTraceIds: traceIds,
      notes: buildNotes(recapStatus, telemetry),
    },
    sessionTelemetrySnapshot: effectiveSnapshot,
    redaction: {
      rawMemoryTextIncluded: false,
      authHeadersIncluded: false,
      cookiesIncluded: false,
      providerTokensIncluded: false,
    },
  };
}

export function buildLastSessionTelemetrySnapshot({
  captureSnapshot,
  capturedAt = new Date().toISOString(),
  metrics,
  summary,
}: {
  captureSnapshot?: SophiaCaptureSnapshot | null;
  capturedAt?: string;
  metrics: VoiceDeveloperMetrics;
  summary: VoiceTelemetrySummary;
}): LastSessionTelemetrySnapshot | null {
  const sessionId = captureSnapshot?.session?.sessionId
    ?? captureSnapshot?.metadata.currentSessionId
    ?? metrics.sessionIds.sessionId
    ?? (metrics.sessionTelemetry.runtime === 'gemini_live'
      ? metrics.sessionTelemetry.gemini.sessionId
      : metrics.sessionTelemetry.legacy.sessionId);

  if (!sessionId) {
    return null;
  }

  const gemini = metrics.sessionTelemetry.runtime === 'gemini_live'
    ? metrics.sessionTelemetry.gemini
    : null;

  return {
    schema: 'sophia-last-session-telemetry-v1',
    capturedAt,
    source: 'session-ui',
    sessionId,
    threadId: captureSnapshot?.session?.threadId
      ?? captureSnapshot?.metadata.currentThreadId
      ?? metrics.sessionIds.threadId,
    runId: captureSnapshot?.metadata.currentRunId ?? metrics.sessionIds.runId,
    status: captureSnapshot?.session?.isActive === false || captureSnapshot?.session?.status === 'ended'
      ? 'ended'
      : captureSnapshot?.session?.isActive === true
        ? 'active'
        : 'unknown',
    endedAt: captureSnapshot?.session?.endedAt ?? null,
    messageCount: captureSnapshot?.session?.messageCount ?? 0,
    stage: metrics.stage,
    runtime: metrics.sessionTelemetry.runtime,
    runtimeSource: metrics.sessionTelemetry.source,
    counts: {
      events: metrics.events.total,
      turns: metrics.counts.turns,
      userTranscripts: metrics.counts.userTranscripts,
      assistantTranscripts: metrics.counts.assistantTranscripts,
      artifacts: metrics.counts.artifacts,
      artifactPublicEventCount: metrics.counts.artifactPublicEventCount,
      artifactRuntimeIngestCount: metrics.counts.artifactRuntimeIngestCount,
      artifactRenderedCount: metrics.counts.artifactRenderedCount,
      diagnostics: metrics.counts.diagnostics,
      builderEvents: metrics.counts.builderEvents,
    },
    voiceSummary: {
      healthLevel: summary.healthLevel,
      bottleneckKind: summary.bottleneckKind,
      bottleneckLevel: summary.bottleneckLevel,
      regressionKeys: summary.regressionKeys,
      sessionReadyMs: summary.sessionReadyMs,
      committedResponseMs: summary.committedResponseMs,
      responseWindowMs: summary.responseWindowMs,
    },
    gemini: gemini
      ? {
          sessionId: gemini.sessionId,
          transport: gemini.transport,
          connectionState: gemini.connectionState,
          websocketState: gemini.websocketState,
          relayStatus: gemini.relayStatus,
          publicSseState: gemini.publicSseState,
          setupComplete: gemini.setupComplete,
          providerEventCount: gemini.providerEventCount,
          outputAudioEventCount: gemini.outputAudioEventCount,
          toolCallCount: gemini.toolCallCount,
          toolResponseCount: gemini.toolResponseCount,
          toolRejectionCount: gemini.toolRejectionCount,
          artifactToolCallCount: gemini.artifactToolCallCount,
          builderToolCallCount: gemini.builderToolCallCount,
          publicTurnCount: gemini.publicTurnCount,
          artifactCount: gemini.artifactCount,
          lastProviderEventAt: gemini.lastProviderEventAt,
          lastToolAt: gemini.lastToolAt,
          lastRelayTraceAt: gemini.lastRelayTraceAt,
          lastAssistantTranscriptAt: gemini.lastAssistantTranscriptAt,
          streamUrlPresent: Boolean(gemini.streamUrl),
          websocketUrlPresent: Boolean(gemini.websocketUrl),
          relayUrlPresent: Boolean(gemini.relayUrl),
        }
      : null,
  };
}

export function persistLastSessionTelemetrySnapshot(snapshot: LastSessionTelemetrySnapshot | null): void {
  if (!snapshot || typeof window === 'undefined') {
    return;
  }

  try {
    const serialized = JSON.stringify(snapshot);
    window.sessionStorage.setItem(`${LAST_SESSION_TELEMETRY_STORAGE_PREFIX}${snapshot.sessionId}`, serialized);
    window.sessionStorage.setItem(`${LAST_SESSION_TELEMETRY_STORAGE_PREFIX}latest`, serialized);
  } catch {
    // Diagnostics should never break the session UI.
  }
}

export function readLastSessionTelemetrySnapshot(sessionId: string): LastSessionTelemetrySnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(`${LAST_SESSION_TELEMETRY_STORAGE_PREFIX}${sessionId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<LastSessionTelemetrySnapshot>;
    if (parsed.schema !== 'sophia-last-session-telemetry-v1' || parsed.sessionId !== sessionId) {
      return null;
    }
    return parsed as LastSessionTelemetrySnapshot;
  } catch {
    return null;
  }
}

export function getResponseShapeKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).sort().slice(0, 50);
}

export function inferAbortReason(error: unknown, signal?: AbortSignal | null): RecapAbortReason {
  const reason = signal?.reason as { name?: unknown } | undefined;
  const reasonName = typeof reason?.name === 'string' ? reason.name : null;
  const errorName = error instanceof DOMException
    ? error.name
    : error instanceof Error
      ? error.name
      : null;

  if (reasonName === 'TimeoutError' || errorName === 'TimeoutError') {
    return 'timeout';
  }

  if (errorName === 'AbortError') {
    return 'unknown';
  }

  return null;
}

export function safeErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 160);
  }
  if (typeof error === 'string' && error.trim()) {
    return error.slice(0, 160);
  }
  return null;
}

function mapPageStatusToRecapDebugStatus(pageStatus: string, memoryCandidateCount?: number): RecapDebugStatus {
  if (pageStatus === 'ready') {
    return memoryCandidateCount === 0 ? 'no_results' : 'ready';
  }
  if (pageStatus === 'reviewed') {
    return 'no_results';
  }
  if (pageStatus === 'loading' || pageStatus === 'processing') {
    return 'composing';
  }
  if (pageStatus === 'unavailable' || pageStatus === 'not_found') {
    return 'error';
  }
  return 'unknown';
}

function isTerminalRecapDebugStatus(status: RecapDebugStatus): boolean {
  return status === 'ready' || status === 'no_results' || status === 'error';
}

function classifyArtifactFieldStatus(
  value: string | null | undefined,
  recapStatus: RecapDebugStatus,
): 'ready' | 'waiting' | 'error' | 'unknown' {
  if (typeof value === 'string' && value.trim().length > 0) {
    return 'ready';
  }
  if (recapStatus === 'composing') {
    return 'waiting';
  }
  if (recapStatus === 'error') {
    return 'error';
  }
  return 'unknown';
}

function classifyMemoryArtifactsStatus(
  recapStatus: RecapDebugStatus,
  memoryCandidateCount: number,
): 'ready' | 'waiting' | 'no_results' | 'error' | 'unknown' {
  if (memoryCandidateCount > 0) {
    return 'ready';
  }
  if (recapStatus === 'composing') {
    return 'waiting';
  }
  if (recapStatus === 'error') {
    return 'error';
  }
  if (recapStatus === 'no_results' || recapStatus === 'ready') {
    return 'no_results';
  }
  return 'unknown';
}

function normalizeCommitStatus(status: string | null | undefined): RecapTelemetryReport['artifacts']['memoryCommitStatus'] {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'committing':
      return 'running';
    case 'committed':
      return 'ready';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

function countReadyArtifacts(artifacts: RecapArtifactsV1 | null | undefined): number {
  if (!artifacts) {
    return 0;
  }

  return [
    artifacts.takeaway,
    artifacts.reflectionCandidate?.prompt,
    artifacts.builderArtifact,
    ...(artifacts.memoryCandidates ?? []),
  ].filter(Boolean).length;
}

function buildWarnings(
  telemetry: RecapTelemetryState,
  snapshot: LastSessionTelemetrySnapshot | null,
): string[] {
  const warnings: string[] = [];

  if (telemetry.memoryRecent.sessionIdIncluded && !telemetry.memoryRecent.nextProxyForwardedSessionId) {
    warnings.push('memory_recent_session_id_not_forwarded_by_next_proxy');
  }

  if (telemetry.memoryRecent.nextProxyForwardedSessionId && !telemetry.memoryRecent.gatewayReceivedSessionId) {
    warnings.push('memory_recent_session_id_not_confirmed_by_gateway');
  }

  if (telemetry.memoryRecent.lastAbortReason === 'timeout') {
    warnings.push('memory_recent_fetch_timed_out');
  }

  if (!telemetry.memoryRecent.requested && telemetry.memoryRecent.memoryRecentNotRequestedReason === 'unknown') {
    warnings.push('memory_recent_not_requested_without_specific_reason');
  }

  if (telemetry.recap.lastAbortReason === 'timeout') {
    warnings.push('recap_fetch_timed_out');
  }

  if (!snapshot) {
    warnings.push('session_telemetry_snapshot_unavailable');
  }

  return warnings;
}

function buildNotes(
  recapStatus: RecapDebugStatus,
  telemetry: RecapTelemetryState,
): string[] {
  const notes: string[] = [];

  if (recapStatus === 'composing') {
    notes.push('recap_page_is_waiting_for_recap_or_pending_memory_candidates');
  }

  if (recapStatus === 'no_results') {
    notes.push('no_results_means_no_pending_review_candidates_for_this_session_not_a_recap_transport_failure');
  }

  if (!telemetry.memoryRecent.requested && telemetry.memoryRecent.memoryRecentNotRequestedReason) {
    notes.push(`memory_recent_not_requested:${telemetry.memoryRecent.memoryRecentNotRequestedReason}`);
  }

  if (telemetry.memoryRecent.terminal && telemetry.memoryRecent.emptyReason !== 'unknown') {
    notes.push(`memory_recent_terminal:${telemetry.memoryRecent.emptyReason}`);
  }

  if (telemetry.memoryRecent.source === 'local_review_overlay') {
    notes.push('memory_recent_used_local_review_overlay_metadata');
  }

  return notes;
}
