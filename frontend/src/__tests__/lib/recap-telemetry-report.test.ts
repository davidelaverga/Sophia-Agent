import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyRecapPageStatus,
  applyRecapRequestObservation,
  buildLastSessionTelemetrySnapshot,
  buildRecapTelemetryReport,
  createInitialRecapTelemetryState,
  persistLastSessionTelemetrySnapshot,
  readLastSessionTelemetrySnapshot,
} from '../../app/lib/recap-telemetry-report';
import type { RecapArtifactsV1 } from '../../app/lib/recap-types';
import type { SophiaCaptureSnapshot } from '../../app/lib/session-capture';
import type { VoiceDeveloperMetrics, VoiceTelemetrySummary } from '../../app/lib/voice-runtime-metrics';

const PRIVATE_MEMORY = 'User private raw memory text should not be exported.';

function makeArtifacts(overrides: Partial<RecapArtifactsV1> = {}): RecapArtifactsV1 {
  return {
    sessionId: 'sess-1',
    threadId: 'thread-1',
    sessionType: 'debrief',
    contextMode: 'work',
    startedAt: '2026-05-25T10:00:00.000Z',
    endedAt: '2026-05-25T10:12:00.000Z',
    takeaway: 'A safe summary.',
    memoryCandidates: [
      {
        id: 'candidate-1',
        text: PRIVATE_MEMORY,
        category: 'lesson',
      },
    ],
    status: 'ready',
    ...overrides,
  };
}

function makeTelemetryWithMemoryRequest() {
  let telemetry = createInitialRecapTelemetryState({
    sessionId: 'sess-1',
    now: '2026-05-25T10:13:00.000Z',
  });
  telemetry = applyRecapPageStatus(telemetry, 'loading', '2026-05-25T10:13:01.000Z');
  telemetry = applyRecapRequestObservation(telemetry, {
    kind: 'recap',
    frontendPath: '/api/sophia/sessions/sess-1/recap',
    startedAt: '2026-05-25T10:13:01.000Z',
    completedAt: '2026-05-25T10:13:01.250Z',
    durationMs: 250,
    status: 200,
    ok: true,
    aborted: false,
    abortReason: null,
    timeoutMs: 5000,
    responseShapeKeys: ['recap_artifacts', 'session_id'],
  });
  return applyRecapRequestObservation(telemetry, {
    kind: 'memory_recent_pending_review',
    frontendPath: '/api/memory/recent?status=pending_review&session_id=sess-1',
    startedAt: '2026-05-25T10:13:01.300Z',
    completedAt: '2026-05-25T10:13:01.620Z',
    durationMs: 320,
    status: 200,
    ok: true,
    aborted: false,
    abortReason: null,
    timeoutMs: 15000,
    responseShapeKeys: ['candidate_count', 'count', 'debug', 'memories', 'source'],
    candidateCount: 1,
    source: 'local_review_overlay',
    emptyReason: 'unknown',
    sessionIdIncluded: true,
    nextProxyForwardedSessionId: true,
    gatewayReceivedSessionId: true,
    safeTraceId: 'memrecent-test',
  });
}

describe('recap telemetry report', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('builds a recap-page report with safe recap and memory-recent metadata', () => {
    const report = buildRecapTelemetryReport({
      sessionId: 'sess-1',
      route: '/recap/sess-1',
      pageStatus: 'ready',
      telemetry: makeTelemetryWithMemoryRequest(),
      artifacts: makeArtifacts(),
      decisions: [
        {
          candidateId: 'candidate-1',
          decision: 'approved',
          status: 'approved',
          timestamp: '2026-05-25T10:14:00.000Z',
        },
      ],
      memoryCommitStatus: 'idle',
      exportedAt: '2026-05-25T10:15:00.000Z',
    });

    expect(report.reportType).toBe('recap-telemetry-report');
    expect(report.version).toBe(1);
    expect(report.source).toBe('recap-ui');
    expect(report.session.sessionId).toBe('sess-1');
    expect(report.recap.status).toBe('ready');
    expect(report.memoryRecent.sessionIdIncluded).toBe(true);
    expect(report.memoryRecent.nextProxyForwardedSessionId).toBe(true);
    expect(report.memoryRecent.gatewayReceivedSessionId).toBe(true);
    expect(report.memoryRecent.status).toBe(200);
    expect(report.memoryRecent.durationMs).toBe(320);
    expect(report.memoryRecent.candidateCount).toBe(1);
    expect(report.memoryRecent.source).toBe('local_review_overlay');
    expect(report.diagnostics.safeTraceIds).toEqual(['memrecent-test']);
    expect(report.redaction).toEqual({
      rawMemoryTextIncluded: false,
      authHeadersIncluded: false,
      cookiesIncluded: false,
      providerTokensIncluded: false,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(PRIVATE_MEMORY);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Cookie');
    expect(serialized).not.toContain('Bearer ');
  });

  it('records timeout abort state distinctly from no-results and errors', () => {
    let telemetry = createInitialRecapTelemetryState({ sessionId: 'sess-timeout' });
    telemetry = applyRecapPageStatus(telemetry, 'processing', '2026-05-25T10:13:01.000Z');
    telemetry = applyRecapRequestObservation(telemetry, {
      kind: 'memory_recent_pending_review',
      frontendPath: '/api/memory/recent?status=pending_review&session_id=sess-timeout',
      startedAt: '2026-05-25T10:13:01.000Z',
      completedAt: '2026-05-25T10:13:16.000Z',
      durationMs: 15000,
      status: null,
      ok: false,
      aborted: true,
      abortReason: 'timeout',
      timeoutMs: 15000,
      responseShapeKeys: [],
      sessionIdIncluded: true,
      nextProxyForwardedSessionId: true,
      gatewayReceivedSessionId: false,
    });

    const composingReport = buildRecapTelemetryReport({
      sessionId: 'sess-timeout',
      route: '/recap/sess-timeout',
      pageStatus: 'processing',
      telemetry,
      artifacts: null,
      decisions: [],
      memoryCommitStatus: 'idle',
    });

    expect(composingReport.recap.status).toBe('composing');
    expect(composingReport.memoryRecent.aborted).toBe(true);
    expect(composingReport.memoryRecent.lastAbortReason).toBe('timeout');
    expect(composingReport.memoryRecent.abortMs).toBe(15000);
    expect(composingReport.diagnostics.warnings).toContain('memory_recent_fetch_timed_out');

    const noResultsReport = buildRecapTelemetryReport({
      sessionId: 'sess-timeout',
      route: '/recap/sess-timeout',
      pageStatus: 'ready',
      telemetry,
      artifacts: makeArtifacts({ memoryCandidates: [] }),
      decisions: [],
      memoryCommitStatus: 'idle',
    });
    expect(noResultsReport.recap.status).toBe('no_results');
    expect(noResultsReport.artifacts.memories).toBe('no_results');

    const errorReport = buildRecapTelemetryReport({
      sessionId: 'sess-timeout',
      route: '/recap/sess-timeout',
      pageStatus: 'unavailable',
      telemetry,
      artifacts: null,
      decisions: [],
      memoryCommitStatus: 'idle',
    });
    expect(errorReport.recap.status).toBe('error');
  });

  it('exports terminal empty and not-requested reasons for memory recent checks', () => {
    let terminalTelemetry = createInitialRecapTelemetryState({ sessionId: 'sess-empty' });
    terminalTelemetry = applyRecapPageStatus(terminalTelemetry, 'ready', '2026-05-25T10:13:01.000Z');
    terminalTelemetry = applyRecapRequestObservation(terminalTelemetry, {
      kind: 'memory_recent_pending_review',
      frontendPath: '/api/memory/recent?status=pending_review&session_id=sess-empty',
      startedAt: '2026-05-25T10:13:01.000Z',
      completedAt: '2026-05-25T10:13:01.120Z',
      durationMs: 120,
      status: 200,
      ok: true,
      aborted: false,
      abortReason: null,
      timeoutMs: 15000,
      responseShapeKeys: ['candidate_count', 'empty_reason', 'memories'],
      candidateCount: 0,
      source: 'local_review_overlay',
      emptyReason: 'no_session_candidates',
      unavailable: false,
      terminal: true,
      sessionIdIncluded: true,
      nextProxyForwardedSessionId: true,
      gatewayReceivedSessionId: true,
    });

    const terminalReport = buildRecapTelemetryReport({
      sessionId: 'sess-empty',
      route: '/recap/sess-empty',
      pageStatus: 'ready',
      telemetry: terminalTelemetry,
      artifacts: makeArtifacts({ sessionId: 'sess-empty', memoryCandidates: [] }),
      decisions: [],
      memoryCommitStatus: 'idle',
    });

    expect(terminalReport.recap.status).toBe('no_results');
    expect(terminalReport.recap.terminalReason).toBe('no_session_candidates');
    expect(terminalReport.memoryRecent.terminal).toBe(true);
    expect(terminalReport.memoryRecent.emptyReason).toBe('no_session_candidates');
    expect(terminalReport.diagnostics.notes).toContain('memory_recent_terminal:no_session_candidates');

    const skippedTelemetry = createInitialRecapTelemetryState({ sessionId: 'sess-skipped' });
    const skippedReport = buildRecapTelemetryReport({
      sessionId: 'sess-skipped',
      route: '/recap/sess-skipped',
      pageStatus: 'not_found',
      telemetry: skippedTelemetry,
      artifacts: null,
      decisions: [],
      memoryCommitStatus: 'idle',
    });

    expect(skippedReport.memoryRecent.requested).toBe(false);
    expect(skippedReport.memoryRecent.memoryRecentNotRequestedReason).toBe('unknown');
    expect(skippedReport.diagnostics.warnings).toContain('memory_recent_not_requested_without_specific_reason');
  });

  it('persists and includes only a same-session safe voice telemetry snapshot', () => {
    const metrics = {
      stage: 'speaking',
      sessionTelemetry: {
        runtime: 'gemini_live',
        runtimeLabel: 'Gemini Live',
        source: 'voice-connect',
        legacy: null,
        gemini: {
          sessionId: 'gemini-session-1',
          streamUrl: '/api/sophia/voice/gemini/events?session_id=sess-1',
          websocketUrl: 'wss://gemini.example/live?access_token=secret-token',
          relayUrl: '/api/sophia/voice/gemini/relay',
          transport: 'browser_websocket',
          connectionState: 'connected',
          websocketState: 'connected',
          relayStatus: 'active',
          publicSseState: 'connected',
          setupComplete: true,
          providerEventCount: 7,
          outputAudioEventCount: 3,
          toolCallCount: 2,
          toolResponseCount: 2,
          toolRejectionCount: 0,
          artifactToolCallCount: 1,
          builderToolCallCount: 0,
          publicTurnCount: 1,
          artifactCount: 1,
          lastProviderEventAt: '2026-05-25T10:10:00.000Z',
          lastToolAt: '2026-05-25T10:10:01.000Z',
          lastRelayTraceAt: '2026-05-25T10:10:02.000Z',
          lastAssistantTranscriptAt: '2026-05-25T10:10:03.000Z',
        },
      },
      sessionIds: {
        sessionId: 'sess-1',
        threadId: 'thread-1',
        runId: 'run-1',
      },
      counts: {
        turns: 1,
        userTranscripts: 1,
        assistantTranscripts: 1,
        artifacts: 1,
        artifactPublicEventCount: 1,
        artifactRuntimeIngestCount: 1,
        artifactSelectedStageCount: 0,
        artifactRenderedCount: 1,
        artifactCountMismatchReason: null,
        diagnostics: 4,
        builderEvents: 0,
      },
      events: {
        total: 12,
      },
    } as unknown as VoiceDeveloperMetrics;
    const summary = {
      healthLevel: 'good',
      bottleneckKind: 'none',
      bottleneckLevel: 'neutral',
      regressionKeys: ['gemini-relay'],
      sessionReadyMs: 900,
      committedResponseMs: 1200,
      responseWindowMs: 2400,
    } as unknown as VoiceTelemetrySummary;
    const captureSnapshot = {
      session: {
        sessionId: 'sess-1',
        threadId: 'thread-1',
        status: 'ended',
        isActive: false,
        endedAt: '2026-05-25T10:12:00.000Z',
        messageCount: 4,
      },
      metadata: {
        currentSessionId: 'sess-1',
        currentThreadId: 'thread-1',
        currentRunId: 'run-1',
      },
    } as unknown as SophiaCaptureSnapshot;

    const snapshot = buildLastSessionTelemetrySnapshot({
      captureSnapshot,
      capturedAt: '2026-05-25T10:12:05.000Z',
      metrics,
      summary,
    });
    persistLastSessionTelemetrySnapshot(snapshot);

    const report = buildRecapTelemetryReport({
      sessionId: 'sess-1',
      route: '/recap/sess-1',
      pageStatus: 'ready',
      telemetry: makeTelemetryWithMemoryRequest(),
      artifacts: makeArtifacts(),
      decisions: [],
      memoryCommitStatus: 'idle',
      sessionTelemetrySnapshot: readLastSessionTelemetrySnapshot('sess-1'),
    });

    expect(report.session.sessionTelemetrySnapshotAvailable).toBe(true);
    expect(report.sessionTelemetrySnapshot?.runtime).toBe('gemini_live');
    expect(report.sessionTelemetrySnapshot?.gemini?.sessionId).toBe('gemini-session-1');
    expect(report.sessionTelemetrySnapshot?.gemini?.websocketUrlPresent).toBe(true);
    expect(JSON.stringify(report)).not.toContain('secret-token');
    expect(JSON.stringify(report)).not.toContain('access_token=');
  });
});
