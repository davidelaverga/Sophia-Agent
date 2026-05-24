import type { SophiaCaptureBundle, SophiaCaptureSnapshot } from './session-capture';
import { buildTurnCaptureDiagnostics, type TurnCaptureDiagnostics } from './turn-capture-diagnostics';
import {
  buildVoiceArtifactTelemetryCounts,
  type VoiceDeveloperMetrics,
  type VoiceTelemetrySummary,
} from './voice-runtime-metrics';

type CaptureEvent = SophiaCaptureBundle['events'][number];

export type VoiceTelemetryCaptureBundle = Omit<SophiaCaptureBundle, 'eventCount' | 'events' | 'snapshot'> & {
  eventCount: number;
  events: CaptureEvent[];
  snapshot: SophiaCaptureSnapshot;
  scope: {
    mode: 'current-run';
    strategy: 'last-start-event' | 'current-session-id' | 'recent-capture-window';
    sourceEventCount: number;
    exportedEventCount: number;
    omittedEarlierEventCount: number;
    scopedFromEventName: string | null;
    scopedFromSeq: number | null;
  };
};

export type VoiceTelemetryReport = {
  reportType: 'voice-telemetry-report';
  version: 2;
  source: 'session-ui';
  exportedAt: string;
  summary: VoiceTelemetrySummary;
  metrics: VoiceDeveloperMetrics;
  diagnosticsSummary: {
    geminiRelayBackend: Record<string, unknown> | null;
    geminiRelayThroughput: Record<string, unknown> | null;
    geminiStaleOutput: Record<string, unknown> | null;
  };
  turnCaptureDiagnostics: TurnCaptureDiagnostics;
  captureBundle: VoiceTelemetryCaptureBundle;
};

const MAX_TELEMETRY_CAPTURE_EVENTS = 500;
const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(token|secret|authorization|api[_-]?key|access[_-]?token|client[_-]?secret|credential|password)(?:$|[_-])/i;
const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'key',
  'secret',
  'token',
]);
const GEMINI_RETRIEVE_MEMORIES_TOOL_NAME = 'retrieve_memories';
const RETRIEVE_MEMORIES_SAFE_TOOL_EXECUTION_KEYS = new Set([
  'any_result_exact_query_terms_present',
  'cache_status',
  'count',
  'has_results',
  'latency_ms',
  'max_query_terms_matched_count',
  'provider_reason',
  'provider_status',
  'provider_transport',
  'query_fingerprint',
  'query_length',
  'query_term_count',
  'raw_memory_text_excluded',
  'raw_query_excluded',
  'result_categories',
  'result_fingerprints',
  'result_preview_included',
  'result_text_lengths',
  'status',
  'trusted_user_id_source',
]);

export function buildVoiceTelemetryReport({
  captureBundle,
  exportedAt,
  metrics,
  summary,
}: {
  captureBundle: SophiaCaptureBundle;
  exportedAt?: string;
  metrics: VoiceDeveloperMetrics;
  summary: VoiceTelemetrySummary;
}): VoiceTelemetryReport {
  const resolvedExportedAt = exportedAt ?? new Date().toISOString();
  const selected = selectCurrentRunEvents(captureBundle.events, captureBundle.snapshot);
  const reconciledMetrics = reconcileArtifactTelemetryMetrics(metrics, captureBundle.snapshot, selected.events);

  return {
    reportType: 'voice-telemetry-report',
    version: 2,
    source: 'session-ui',
    exportedAt: resolvedExportedAt,
    summary: sanitizeTelemetryValue(summary) as VoiceTelemetrySummary,
    metrics: sanitizeTelemetryValue(reconciledMetrics) as VoiceDeveloperMetrics,
    diagnosticsSummary: buildDiagnosticsSummary(captureBundle, selected),
    turnCaptureDiagnostics: sanitizeTelemetryValue(
      buildTurnCaptureDiagnostics(selected.events, reconciledMetrics),
    ) as TurnCaptureDiagnostics,
    captureBundle: buildScopedTelemetryCaptureBundle(captureBundle, resolvedExportedAt, selected),
  };
}

function reconcileArtifactTelemetryMetrics(
  metrics: VoiceDeveloperMetrics,
  snapshot: SophiaCaptureSnapshot,
  selectedEvents: CaptureEvent[],
): VoiceDeveloperMetrics {
  const artifactMetrics = buildVoiceArtifactTelemetryCounts({
    events: selectedEvents,
    snapshot,
  });
  const counts = {
    ...metrics.counts,
    artifacts: artifactMetrics.artifactCount,
    artifactPublicEventCount: artifactMetrics.artifactPublicEventCount,
    artifactRuntimeIngestCount: artifactMetrics.artifactRuntimeIngestCount,
    artifactRenderedCount: artifactMetrics.artifactRenderedCount,
    artifactCountSource: artifactMetrics.artifactCountSource,
    artifactCountMismatch: artifactMetrics.artifactCountMismatch,
  };

  if (metrics.sessionTelemetry.runtime !== 'gemini_live') {
    return {
      ...metrics,
      counts,
    };
  }

  return {
    ...metrics,
    counts,
    sessionTelemetry: {
      ...metrics.sessionTelemetry,
      gemini: {
        ...metrics.sessionTelemetry.gemini,
        artifactCount: artifactMetrics.artifactCount,
        artifactPublicEventCount: artifactMetrics.artifactPublicEventCount,
        artifactRuntimeIngestCount: artifactMetrics.artifactRuntimeIngestCount,
        artifactRenderedCount: artifactMetrics.artifactRenderedCount,
        artifactCountSource: artifactMetrics.artifactCountSource,
        artifactCountMismatch: artifactMetrics.artifactCountMismatch,
      },
    },
  };
}

function buildScopedTelemetryCaptureBundle(
  captureBundle: SophiaCaptureBundle,
  exportedAt: string,
  selected = selectCurrentRunEvents(captureBundle.events, captureBundle.snapshot),
): VoiceTelemetryCaptureBundle {
  const compactEvents = selected.events.map(compactTelemetryCaptureEvent);
  const events = sanitizeTelemetryValue(compactEvents) as CaptureEvent[];
  const snapshot = sanitizeCaptureSnapshot(captureBundle.snapshot);
  const scopedStartedAt = events[0]?.recordedAt ?? captureBundle.startedAt;

  return {
    startedAt: scopedStartedAt,
    exportedAt,
    eventCount: events.length,
    events,
    snapshot,
    scope: {
      mode: 'current-run',
      strategy: selected.strategy,
      sourceEventCount: captureBundle.events.length,
      exportedEventCount: events.length,
      omittedEarlierEventCount: Math.max(captureBundle.events.length - events.length, 0),
      scopedFromEventName: events[0]?.name ?? null,
      scopedFromSeq: typeof events[0]?.seq === 'number' ? events[0].seq : null,
    },
  };
}

function selectCurrentRunEvents(
  events: CaptureEvent[],
  snapshot: SophiaCaptureSnapshot,
): {
  events: CaptureEvent[];
  strategy: VoiceTelemetryCaptureBundle['scope']['strategy'];
} {
  const lastStartIndex = findLastIndex(
    events,
    (event) => event.category === 'voice-session' && event.name === 'start-talking-requested',
  );

  if (lastStartIndex >= 0) {
    return {
      events: events.slice(lastStartIndex).slice(-MAX_TELEMETRY_CAPTURE_EVENTS),
      strategy: 'last-start-event',
    };
  }

  const currentSessionId = snapshot.session?.sessionId ?? snapshot.metadata.currentSessionId;
  if (currentSessionId) {
    const sessionEvents = events.filter((event) => eventMentionsSessionId(event, currentSessionId));
    if (sessionEvents.length > 0) {
      return {
        events: sessionEvents.slice(-MAX_TELEMETRY_CAPTURE_EVENTS),
        strategy: 'current-session-id',
      };
    }
  }

  return {
    events: events.slice(-Math.min(MAX_TELEMETRY_CAPTURE_EVENTS, 120)),
    strategy: 'recent-capture-window',
  };
}

function sanitizeCaptureSnapshot(snapshot: SophiaCaptureSnapshot): SophiaCaptureSnapshot {
  const sanitized = sanitizeTelemetryValue(snapshot) as SophiaCaptureSnapshot;

  return {
    ...sanitized,
    location: {
      ...sanitized.location,
      href: sanitizeUrlText(sanitized.location.href),
    },
    transcript: {
      chatMessages: [],
      voiceMessages: [],
      dom: {
        articleCount: sanitized.transcript.dom.articleCount,
        articles: [],
      },
    },
    artifacts: {
      sessionArtifacts: null,
      recapArtifacts: null,
      recapCommitStatus: sanitized.artifacts.recapCommitStatus,
      dom: {
        railLabel: sanitized.artifacts.dom.railLabel,
        takeawayText: null,
        reflectionText: null,
        memoriesText: null,
        panelVisible: sanitized.artifacts.dom.panelVisible,
      },
    },
    metadata: {
      currentSessionId: sanitized.metadata.currentSessionId,
      currentThreadId: sanitized.metadata.currentThreadId,
      currentRunId: sanitized.metadata.currentRunId,
      emotionalWeather: null,
    },
    storage: {},
  };
}

function sanitizeTelemetryValue(value: unknown, keyName?: string, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return keyName && SENSITIVE_KEY_PATTERN.test(keyName)
      ? REDACTED
      : sanitizeUrlText(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTelemetryValue(entry, keyName, seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => {
      if (SENSITIVE_KEY_PATTERN.test(entryKey)) {
        return [entryKey, REDACTED];
      }
      return [entryKey, sanitizeTelemetryValue(entryValue, entryKey, seen)];
    }),
  );
}

function sanitizeUrlText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const sanitizedByParser = sanitizeUrlWithParser(trimmed);
  const sanitized = sanitizedByParser ?? trimmed;

  return sanitized
    .replace(/(access_token=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/(auth_tokens\/)[^&#/\s]+/gi, `$1${REDACTED}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, `$1${REDACTED}`);
}

function sanitizeUrlWithParser(value: string): string | null {
  const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  const isRelative = value.startsWith('/') || value.startsWith('?');
  if (!isAbsolute && !isRelative) {
    return null;
  }

  try {
    const url = new URL(value, 'https://sophia.local');
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED);
      }
    }

    if (isAbsolute) {
      return url.toString();
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function eventMentionsSessionId(event: CaptureEvent, sessionId: string): boolean {
  return deepContainsString(event.payload, sessionId);
}

function deepContainsString(value: unknown, expected: string, seen = new WeakSet<object>()): boolean {
  if (value === expected) {
    return true;
  }

  if (value === null || typeof value !== 'object') {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => deepContainsString(entry, expected, seen));
  }

  return Object.values(value as Record<string, unknown>).some((entry) => deepContainsString(entry, expected, seen));
}

function buildGeminiRelayBackendDiagnosticsSummary(events: CaptureEvent[]): Record<string, unknown> | null {
  const diagnostics = events
    .filter((event) => event.name === 'gemini-relay-trace')
    .map((event) => asRecord(asRecord(asRecord(event.payload)?.trace)?.backendDiagnostics))
    .filter((value): value is Record<string, unknown> => value !== null);

  if (!diagnostics.length) {
    return null;
  }

  const compacted = diagnostics.map(compactGeminiRelayBackendDiagnostics);
  const latest = compacted.at(-1) ?? null;

  return {
    schema: 'gemini_relay_backend_summary_v1',
    relayTraceCountWithBackendDiagnostics: diagnostics.length,
    latestSessionId: latest ? asString(latest.session_id) : null,
    maxRawProviderEventsAccepted: maxNumericField(compacted, 'raw_provider_events_accepted'),
    maxProviderEventsPushedIntoMapper: maxNumericField(compacted, 'provider_events_pushed_into_mapper'),
    maxProviderCategoryCountTotal: maxNumericField(compacted, 'provider_category_count_total'),
    maxFunctionCallsExtractedCount: maxNumericField(compacted, 'function_calls_extracted_count'),
    maxCancellationIdsObservedCount: maxNumericField(compacted, 'cancellation_ids_observed_count'),
    maxToolExecutionCountTotal: maxNumericField(compacted, 'tool_execution_count_total'),
    maxProviderEventMappingOutputTotal: maxNumericField(compacted, 'provider_event_mapping_output_total'),
    maxPublicSophiaEmittedCountTotal: maxNumericField(compacted, 'public_sophia_emitted_count_total'),
    latestToolExecution: latest ? latest.latest_tool_execution ?? null : null,
  };
}

function compactGeminiRelayBackendDiagnostics(diagnostics: Record<string, unknown>): Record<string, unknown> {
  const providerCategoryCounts = asRecord(diagnostics.provider_category_counts) ?? asRecord(diagnostics.providerCategoryCounts);
  const functionCalls = asRecord(diagnostics.function_calls_extracted) ?? asRecord(diagnostics.functionCallsExtracted);
  const cancellations = Array.isArray(diagnostics.cancellation_ids_observed)
    ? diagnostics.cancellation_ids_observed
    : Array.isArray(diagnostics.cancellationIdsObserved)
      ? diagnostics.cancellationIdsObserved
      : [];
  const toolExecutionCounts = asRecord(diagnostics.tool_execution_counts) ?? asRecord(diagnostics.toolExecutionCounts);
  const toolExecutionRecent = Array.isArray(diagnostics.tool_execution_recent)
    ? diagnostics.tool_execution_recent
    : Array.isArray(diagnostics.toolExecutionRecent)
      ? diagnostics.toolExecutionRecent
      : [];
  const mappingOutputs = asRecord(diagnostics.provider_event_mapping_outputs) ?? asRecord(diagnostics.providerEventMappingOutputs);
  const publicCounts = asRecord(diagnostics.public_sophia_emitted_counts) ?? asRecord(diagnostics.publicSophiaEmittedCounts);
  const latestToolExecution = asRecord(toolExecutionRecent.filter((entry) => asRecord(entry)).at(-1));

  return {
    schema: 'gemini_backend_diagnostics_compact_v1',
    session_id: asString(diagnostics.session_id) ?? asString(diagnostics.sessionId),
    raw_provider_events_accepted: asFiniteNumber(diagnostics.raw_provider_events_accepted) ?? asFiniteNumber(diagnostics.rawProviderEventsAccepted),
    provider_events_pushed_into_mapper: asFiniteNumber(diagnostics.provider_events_pushed_into_mapper) ?? asFiniteNumber(diagnostics.providerEventsPushedIntoMapper),
    provider_category_count_total: sumNumericRecord(providerCategoryCounts),
    function_calls_extracted_count: functionCalls ? Object.keys(functionCalls).length : asFiniteNumber(diagnostics.function_calls_extracted_count) ?? 0,
    cancellation_ids_observed_count: numericFallback(cancellations.length, diagnostics.cancellation_ids_observed_count),
    tool_execution_count_total: numericFallback(sumNumericRecord(toolExecutionCounts), diagnostics.tool_execution_count_total),
    tool_execution_recent_count: numericFallback(toolExecutionRecent.length, diagnostics.tool_execution_recent_count),
    provider_event_mapping_output_total: numericFallback(sumNumericRecord(mappingOutputs), diagnostics.provider_event_mapping_output_total),
    public_sophia_emitted_count_total: numericFallback(sumNumericRecord(publicCounts), diagnostics.public_sophia_emitted_count_total),
    latest_tool_execution: latestToolExecution
      ? compactLatestToolExecution(latestToolExecution)
      : diagnostics.latest_tool_execution ?? null,
  };
}

function compactLatestToolExecution(latestToolExecution: Record<string, unknown>): Record<string, unknown> {
  const toolName = asString(latestToolExecution.tool_name) ?? asString(latestToolExecution.toolName);
  const compact: Record<string, unknown> = {
    phase: asString(latestToolExecution.phase),
    tool_call_id: asString(latestToolExecution.tool_call_id) ?? asString(latestToolExecution.toolCallId),
    tool_name: toolName,
    recorded_at: asFiniteNumber(latestToolExecution.recorded_at) ?? asFiniteNumber(latestToolExecution.recordedAt),
  };
  if (toolName === GEMINI_RETRIEVE_MEMORIES_TOOL_NAME) {
    for (const key of RETRIEVE_MEMORIES_SAFE_TOOL_EXECUTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(latestToolExecution, key)) {
        compact[key] = key === 'result_fingerprints'
          ? compactRetrieveMemoriesResultFingerprints(latestToolExecution[key])
          : latestToolExecution[key];
      }
    }
  }
  return compact;
}

function compactRetrieveMemoriesResultFingerprints(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const safeKeys = new Set([
    'category',
    'exact_query_terms_present',
    'query_term_count',
    'query_terms_matched_count',
    'rank',
    'score',
    'text_fingerprint',
    'text_length',
  ]);
  return value
    .filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null)
    .map((fingerprint) => Object.fromEntries(
      Object.entries(fingerprint).filter(([key]) => safeKeys.has(key)),
    ));
}

function buildGeminiRelayThroughputSummary(events: CaptureEvent[]): Record<string, unknown> | null {
  const throughputEntries = events
    .filter((event) => event.name === 'gemini-relay-trace')
    .map((event) => asRecord(asRecord(asRecord(event.payload)?.trace)?.throughput))
    .filter((value): value is Record<string, unknown> => value !== null);
  const coalescingDiagnostics = events
    .filter((event) => event.name === 'gemini-transcript-partial-coalesced')
    .map((event) => asRecord(asRecord(event.payload)?.diagnostic))
    .filter((value): value is Record<string, unknown> => value !== null);

  if (!throughputEntries.length && !coalescingDiagnostics.length) {
    return null;
  }

  const latest = throughputEntries.at(-1) ?? asRecord(coalescingDiagnostics.at(-1)?.metrics);
  const coalescedBySegment = latest ? asRecord(latest.coalescedBySegment) : null;

  return {
    schema: 'gemini_relay_throughput_summary_v1',
    relayTraceCountWithThroughput: throughputEntries.length,
    coalescingDiagnosticCount: coalescingDiagnostics.length,
    latestOrderedRelayQueueDepth: latest ? asFiniteNumber(latest.orderedRelayQueueDepth) : null,
    maxOrderedRelayQueueDepth: maxNumericField(throughputEntries, 'orderedRelayQueueDepth'),
    maxOldestQueuedAgeMs: maxNumericField(throughputEntries, 'oldestQueuedAgeMs'),
    transcriptPartialsCoalesced: latest ? asFiniteNumber(latest.transcriptPartialsCoalesced) : null,
    transcriptPartialsSent: latest ? asFiniteNumber(latest.transcriptPartialsSent) : null,
    transcriptPartialsDropped: latest ? asFiniteNumber(latest.transcriptPartialsDropped) : null,
    transcriptCoalescingDisabledReason: latest ? asString(latest.transcriptCoalescingDisabledReason) : null,
    finalTranscriptEventsSent: latest ? asFiniteNumber(latest.finalTranscriptEventsSent) : null,
    nonDroppableCriticalEventsSent: latest ? asFiniteNumber(latest.nonDroppableCriticalEventsSent) : null,
    lastTranscriptRelayLatencyMs: latest ? asFiniteNumber(latest.lastTranscriptRelayLatencyMs) : null,
    maxTranscriptRelayLatencyMs: maxNumericField(throughputEntries, 'maxTranscriptRelayLatencyMs'),
    p95TranscriptRelayLatencyMs: latest ? asFiniteNumber(latest.p95TranscriptRelayLatencyMs) : null,
    coalescedBySegment,
  };
}

function buildGeminiStaleOutputDiagnosticsSummary(events: CaptureEvent[]): Record<string, unknown> | null {
  const staleSuppressionDiagnostics = events
    .filter((event) => event.name === 'gemini-stale-output-suppressed')
    .map((event) => asRecord(asRecord(event.payload)?.diagnostic))
    .filter((value): value is Record<string, unknown> => value !== null);
  const staleTranscriptIgnored = events.filter((event) => event.name === 'stale-assistant-transcript-ignored');
  const interruptionDiagnostics = events
    .filter((event) => event.name === 'gemini-interruption')
    .map((event) => asRecord(asRecord(event.payload)?.diagnostic))
    .filter((value): value is Record<string, unknown> => value !== null);
  const throughputSummary = buildGeminiRelayThroughputSummary(events);
  const latestToolEntries = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.name !== 'gemini-tool-call-ledger') {
      continue;
    }
    const entry = asRecord(asRecord(event.payload)?.entry);
    const toolCallId = asString(entry?.toolCallId);
    if (entry && toolCallId) {
      latestToolEntries.set(toolCallId, entry);
    }
  }
  const unresolvedToolEntries = [...latestToolEntries.values()].filter((entry) => asString(entry.finalState) === 'unknown');
  const warnings: string[] = [];
  const maxOldestQueuedAgeMs = asFiniteNumber(throughputSummary?.maxOldestQueuedAgeMs);
  const maxTranscriptRelayLatencyMs = asFiniteNumber(throughputSummary?.maxTranscriptRelayLatencyMs);
  const staleAudioDroppedCount = staleSuppressionDiagnostics.filter((diagnostic) => asString(diagnostic.outputType) === 'audio').length;
  const staleTranscriptDroppedCount = staleSuppressionDiagnostics.filter((diagnostic) => asString(diagnostic.outputType) === 'transcript').length
    + staleTranscriptIgnored.length;
  if (staleAudioDroppedCount > 0 || staleTranscriptDroppedCount > 0) {
    warnings.push('stale_assistant_output_suppressed');
  }
  if ((maxOldestQueuedAgeMs ?? 0) >= 30_000 || (maxTranscriptRelayLatencyMs ?? 0) >= 30_000) {
    warnings.push('transcript_relay_backlog_exceeded');
  }
  if (unresolvedToolEntries.length > 0) {
    warnings.push('unresolved_gemini_tool_calls');
  }
  const maxAssistantUserOverlapMs = maxNumericField(interruptionDiagnostics, 'assistantUserOverlapMs');
  if ((maxAssistantUserOverlapMs ?? 0) >= 1_500) {
    warnings.push('assistant_audio_overlapped_user_input');
  }

  if (!warnings.length && !staleSuppressionDiagnostics.length && !staleTranscriptIgnored.length && !unresolvedToolEntries.length) {
    return null;
  }

  return {
    schema: 'gemini_stale_output_diagnostics_summary_v1',
    warnings,
    staleAssistantAudioDroppedCount: staleAudioDroppedCount,
    staleAssistantTranscriptDroppedCount: staleTranscriptDroppedCount,
    staleAssistantOutputSuppressionCount: staleSuppressionDiagnostics.length + staleTranscriptIgnored.length,
    maxAssistantUserOverlapMs,
    maxOldestQueuedAgeMs,
    maxTranscriptRelayLatencyMs,
    unresolvedToolCallCount: unresolvedToolEntries.length,
    artifactToolCallUnknownCount: unresolvedToolEntries.filter((entry) => asString(entry.toolName) === 'emit_artifact').length,
    interruptedResponseIds: asRecord(interruptionDiagnostics.at(-1))
      ? interruptionDiagnostics.at(-1)?.interruptedResponseIds ?? []
      : [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumNumericRecord(value: Record<string, unknown> | null): number {
  if (!value) {
    return 0;
  }
  return Object.values(value).reduce<number>((total, entry) => (
    typeof entry === 'number' && Number.isFinite(entry) ? total + entry : total
  ), 0);
}

function maxNumericField(values: Record<string, unknown>[], key: string): number | null {
  let maxValue: number | null = null;
  for (const value of values) {
    const candidate = asFiniteNumber(value[key]);
    if (candidate === null) {
      continue;
    }
    maxValue = maxValue === null ? candidate : Math.max(maxValue, candidate);
  }
  return maxValue;
}

function numericFallback(primary: number, fallback: unknown): number {
  return primary > 0 ? primary : asFiniteNumber(fallback) ?? 0;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return index;
    }
  }
  return -1;
}

function buildDiagnosticsSummary(
  captureBundle: SophiaCaptureBundle,
  selected = selectCurrentRunEvents(captureBundle.events, captureBundle.snapshot),
): VoiceTelemetryReport['diagnosticsSummary'] {
  return {
    geminiRelayBackend: buildGeminiRelayBackendDiagnosticsSummary(selected.events),
    geminiRelayThroughput: buildGeminiRelayThroughputSummary(selected.events),
    geminiStaleOutput: buildGeminiStaleOutputDiagnosticsSummary(selected.events),
  };
}

function compactTelemetryCaptureEvent(event: CaptureEvent): CaptureEvent {
  if (event.name !== 'gemini-relay-trace') {
    return event;
  }
  const payload = asRecord(event.payload);
  const trace = asRecord(payload?.trace);
  const backendDiagnostics = asRecord(trace?.backendDiagnostics);
  if (!payload || !trace || !backendDiagnostics) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...payload,
      trace: {
        ...trace,
        backendDiagnostics: compactGeminiRelayBackendDiagnostics(backendDiagnostics),
      },
    },
  };
}