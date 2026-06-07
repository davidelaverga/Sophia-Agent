import type { SophiaCaptureBundle, SophiaCaptureSnapshot } from './session-capture';
import { buildTurnCaptureDiagnostics, type TurnCaptureDiagnostics } from './turn-capture-diagnostics';
import {
  buildVoiceArtifactTelemetryCounts,
  type CoreviewUsageTelemetry,
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
  coreview: CoreviewUsageTelemetry;
  metrics: VoiceDeveloperMetrics;
  diagnosticsSummary: {
    geminiRelayBackend: Record<string, unknown> | null;
    geminiRelayThroughput: Record<string, unknown> | null;
    geminiStaleOutput: Record<string, unknown> | null;
    builderSurface: Record<string, unknown>;
    artifactReview: Record<string, unknown>;
    coreviewStillFrame: Record<string, unknown>;
  };
  turnCaptureDiagnostics: TurnCaptureDiagnostics;
  captureBundle: VoiceTelemetryCaptureBundle;
};

const MAX_TELEMETRY_CAPTURE_EVENTS = 500;
const REDACTED = '[redacted]';
const TRANSCRIPT_RELAY_LATENCY_WARNING_MS = 15_000;
const ORDERED_RELAY_QUEUE_DEPTH_WARNING = 20;
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
const GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME = 'read_artifact_text';
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
const READ_ARTIFACT_TEXT_SAFE_TOOL_EXECUTION_KEYS = new Set([
  'artifact_id',
  'char_count',
  'latency_ms',
  'page_count',
  'raw_artifact_text_excluded',
  'safe_reason',
  'source',
  'status',
  'truncated',
  'review_tool_timed_out',
  'review_tool_timeout_name',
  'review_tool_timeout_result_sent',
]);
const COREVIEW_SAFE_TOOL_EXECUTION_KEYS = new Set([
  'action',
  'annotation_action_source',
  'annotation_anchor_type',
  'annotation_color',
  'annotation_command_kept_artifact_mounted',
  'annotation_command_prevented_navigation',
  'annotation_commit_attempted',
  'annotation_commit_count_after',
  'annotation_commit_count_before',
  'annotation_commit_result',
  'annotation_commit_verified',
  'annotation_count',
  'annotation_created',
  'annotation_delete_count',
  'annotation_edit_count',
  'annotation_export_available',
  'annotation_export_kind',
  'annotation_export_page_scope',
  'annotation_export_result',
  'annotation_fallback_attempted',
  'annotation_fallback_blocked_reason',
  'annotation_fallback_result',
  'annotation_fallback_utterance_kind',
  'annotation_kind',
  'annotation_intent_detected_count',
  'annotation_intent_source',
  'annotation_overlay_captured',
  'annotation_partial_success',
  'annotation_page_index',
  'annotation_persist_attempted',
  'annotation_persist_count',
  'annotation_persist_result',
  'annotation_persisted_count',
  'annotation_persistence_status',
  'annotation_identity_read_hash',
  'annotation_identity_write_hash',
  'annotation_restore_attempted',
  'annotation_restore_count',
  'annotation_restore_overwritten_count',
  'annotation_restore_result',
  'annotation_restore_source',
  'annotation_migrated_identity_count',
  'annotation_prevented_empty_overwrite_count',
  'annotation_store_hydrated_artifact_stage',
  'annotation_store_survived_canvas_close',
  'annotation_state_cleared_reason',
  'annotation_storage_key_hash',
  'annotation_storage_version',
  'annotation_view_ready_timed_out',
  'arrow_count',
  'assistant_annotation_claim_suppressed_count',
  'blocked_reason',
  'blockedReason',
  'canvas_restore_attempted',
  'canvas_restore_result',
  'canvas_restore_source',
  'canvas_restored_artifact_identity_hash',
  'capability_summary',
  'comment_count',
  'command_source',
  'context_present',
  'artifact_path_present',
  'artifact_stable_identity_present',
  'original_artifact_href_present',
  'capability_supports_artifact_update',
  'capability_supports_source_read',
  'capability_supports_versioning',
  'current_page',
  'coreviewBuilderActionsEnabled',
  'coreviewBuilderActionsBlockedReason',
  'coreviewBuilderToolsExposed',
  'coreviewBuilderGenericToolsSuppressed',
  'coreviewBuilderActiveTaskState',
  'coreviewBuilderStatusToolResult',
  'editBuilderArtifactInterceptedByCoreview',
  'editBuilderArtifactDirectCallResult',
  'coreviewUpdateStateCreatedFromDirectEditTool',
  'coreviewUpdateCardVisible',
  'coreviewHtmlLiveUpdateEnabled',
  'coreviewArtifactVersioningEnabled',
  'coreviewArtifactLogicalId',
  'coreviewArtifactOriginalVersionIdPresent',
  'coreviewArtifactCurrentVersionIdPresent',
  'coreviewArtifactVersionCount',
  'coreviewHtmlUpdateMatchedBy',
  'coreviewHtmlUpdateAutoApplyAttempted',
  'coreviewHtmlUpdateAutoApplied',
  'coreviewHtmlUpdateAutoApplyResult',
  'coreviewHtmlUpdateRenderConfirmed',
  'coreviewHtmlUpdatePreviewRefreshFailed',
  'coreviewHtmlUpdatePreviousPathHash',
  'coreviewHtmlUpdateCurrentPathHash',
  'coreviewHtmlUpdateRestoreAvailable',
  'coreviewHtmlUpdateRestoreResult',
  'coreviewHtmlUpdateNoViewClickRequired',
  'coreviewHtmlUpdateSuppressedCompletedBuilderSurface',
  'coreviewHtmlUpdateSuppressedDuplicateReplyCount',
  'coreviewHtmlUpdateSuccessClaimBlockedUntilRender',
  'coreviewHtmlUpdateSelectedPathChanged',
  'coreviewHtmlUpdatePreservedReview',
  'coreviewHtmlUpdatePreservedMic',
  'coreviewHtmlQuickPatchEligible',
  'coreviewHtmlQuickPatchAttempted',
  'coreviewHtmlQuickPatchResult',
  'coreviewHtmlQuickPatchKind',
  'coreviewHtmlQuickPatchFallbackReason',
  'coreviewHtmlQuickPatchLatencyMs',
  'coreviewHtmlQuickPatchRevisionPathHash',
  'coreviewHtmlQuickPatchUsedFullBuilder',
  'coreviewHtmlQuickPatchRenderConfirmed',
  'coreviewHtmlQuickPatchPreservedOriginal',
  'coreviewHtmlQuickPatchRestoreAvailable',
  'coreviewHtmlQuickPatchTypeErrorPrevented',
  'coreviewActionFeedbackEmitted',
  'coreview_action_feedback_emitted',
  'coreviewActionFeedbackKind',
  'coreview_action_feedback_kind',
  'coreviewActionFeedbackStatus',
  'coreview_action_feedback_status',
  'coreviewActionFeedbackSpoken',
  'coreview_action_feedback_spoken',
  'coreviewActionFeedbackAudioAttempted',
  'coreview_action_feedback_audio_attempted',
  'coreviewActionFeedbackAudioResult',
  'coreview_action_feedback_audio_result',
  'coreviewActionFeedbackDedupeSuppressedCount',
  'coreview_action_feedback_dedupe_suppressed_count',
  'coreviewActionFeedbackRawContentExcluded',
  'coreview_action_feedback_raw_content_excluded',
  'voiceAudioAckUnavailable',
  'voice_audio_ack_unavailable',
  'coreviewHtmlAnnotationsEnabled',
  'coreview_html_annotations_enabled',
  'coreviewHtmlAnnotationKind',
  'coreview_html_annotation_kind',
  'coreviewHtmlAnnotationAnchorType',
  'coreview_html_annotation_anchor_type',
  'coreviewHtmlAnnotationResult',
  'coreview_html_annotation_result',
  'coreviewHtmlAnnotationPersisted',
  'coreview_html_annotation_persisted',
  'htmlCaptureTargetRegistered',
  'htmlCaptureTargetRegistrationResult',
  'htmlCaptureTargetArtifactPathHash',
  'htmlCaptureTargetStableIdentityHash',
  'htmlCaptureTargetVersionAware',
  'htmlCaptureTargetRebindCount',
  'htmlCaptureTargetMissingBeforeRetry',
  'htmlCaptureTargetRetryAttempted',
  'htmlCaptureTargetRetryResult',
  'htmlCaptureTargetReadyLatencyMs',
  'htmlFrameCaptureSourceKind',
  'htmlFrameCaptureSucceeded',
  'htmlFrameCaptureFailureReason',
  'htmlVisiblePreviewResponsive',
  'htmlVisiblePreviewUsesCaptureDimensions',
  'htmlVisiblePreviewWidth',
  'htmlVisiblePreviewHeight',
  'htmlVisiblePreviewScrollMode',
  'htmlVisibleRendererKind',
  'htmlVisibleRendererInteractive',
  'htmlVisibleIframePointerEvents',
  'htmlOverlayPointerEventsMode',
  'htmlOffscreenCaptureAffectsLayout',
  'htmlScrollMode',
  'htmlScrollContainerResolved',
  'htmlScrollTop',
  'htmlScrollHeight',
  'htmlViewportHeight',
  'htmlScrollAttempted',
  'htmlScrollResult',
  'htmlFocusAnchorAttempted',
  'htmlFocusAnchorResult',
  'htmlFocusAnchorMethod',
  'htmlFocusAnchorScrolled',
  'htmlInternalNavigationAttempted',
  'htmlInternalNavigationResult',
  'htmlInternalNavigationTargetKind',
  'htmlInternalNavigationPreventedDefault',
  'htmlInternalNavigationBlockedExternal',
  'htmlInternalNavigationScrolled',
  'htmlInternalNavigationFailureReason',
  'htmlVoiceNavigationUsedSameResolver',
  'htmlPostMessageNavigationReceived',
  'htmlNavigationPreservedCaptureTarget',
  'htmlAnnotationOverlayCapturing',
  'htmlBrowserInteractionEnabled',
  'htmlPageRailHidden',
  'htmlThumbnailRailHidden',
  'htmlCoreviewCommandModel',
  'htmlFitModeApplied',
  'htmlZoomScale',
  'htmlReviewStatusResolved',
  'htmlReviewStatusReason',
  'reviewStartWaitedForHtmlCaptureTarget',
  'reviewStartHtmlCaptureTargetResult',
  'genericAsyncToolBlockedReason',
  'genericAsyncToolRespondedSafely',
  'generic_async_tool_blocked_reason',
  'generic_async_tool_responded_safely',
  'latest_output_path_present',
  'preservedMic',
  'preservedReview',
  'preserved_mic',
  'preserved_review',
  'raw_user_update_request_excluded',
  'requested_change_summary_length',
  'result',
  'run_id_present',
  'status_cancellable',
  'status_phase',
  'suppressed_tool_name',
  'task_id_present',
  'update_mode',
  'coreview_workspace_contract_version',
  'coreview_workspace_event_log_active',
  'coreview_annotation_command_source',
  'coreview_annotation_fallback_count',
  'coreview_annotation_fallback_result',
  'coreview_annotation_state_source',
  'coreview_annotation_store_active',
  'coreview_share_status',
  'coreview_workspace_actor_kind',
  'coreview_workspace_event_count',
  'coreview_workspace_has_share_ready_metadata',
  'coreview_workspace_last_event_type',
  'current_view_summary',
  'fit_mode',
  'focus_anchor_type',
  'highlight_count',
  'last_tool_mode_after_action',
  'last_tool_mode_before_action',
  'draw_path_count',
  'ok',
  'page_count',
  'page_index',
  'page_number',
  'preserved_mic',
  'preserved_review',
  'raw_artifact_text_excluded',
  'raw_comment_text_excluded',
  'rawCommentTextExcluded',
  'raw_frame_excluded',
  'recent_annotation_action_succeeded',
  'refresh_attempted',
  'refresh_result',
  'renderer_kind',
  'result_summary',
  'review_active',
  'session_leave_guard_suppressed_for_annotation',
  'stale',
  'sticky_tool_mode_enabled',
  'tool_mode_reset_reason',
  'underline_count',
  'unsupported_annotation_kind',
  'workspace_event_log_persist_result',
  'workspace_event_log_restore_count',
  'annotation_events_created_count',
  'view_changed_event_count',
  'visual_fresh',
  'visual_frame_fresh',
  'zoom',
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

  const sanitizedMetrics = sanitizeTelemetryValue(reconciledMetrics) as VoiceDeveloperMetrics;
  return {
    reportType: 'voice-telemetry-report',
    version: 2,
    source: 'session-ui',
    exportedAt: resolvedExportedAt,
    summary: sanitizeTelemetryValue(summary) as VoiceTelemetrySummary,
    coreview: sanitizeTelemetryValue(reconciledMetrics.coreview) as CoreviewUsageTelemetry,
    metrics: sanitizedMetrics,
    diagnosticsSummary: buildDiagnosticsSummary(selected, reconciledMetrics),
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
    artifactSelectedStageCount: artifactMetrics.artifactSelectedStageCount,
    artifactRenderedCount: artifactMetrics.artifactRenderedCount,
    artifactCountSource: artifactMetrics.artifactCountSource,
    artifactCountMismatch: artifactMetrics.artifactCountMismatch,
    artifactCountMismatchReason: artifactMetrics.artifactCountMismatchReason,
  };
  const coreviewCommandTelemetry = buildCoreviewCommandTelemetryPatch(selectedEvents);
  const coreview = {
    ...metrics.coreview,
    visual: {
      ...metrics.coreview.visual,
      ...coreviewCommandTelemetry,
    },
  };

  if (metrics.sessionTelemetry.runtime !== 'gemini_live') {
    return {
      ...metrics,
      counts,
      coreview,
    };
  }

  return {
    ...metrics,
    counts,
    coreview,
    sessionTelemetry: {
      ...metrics.sessionTelemetry,
      gemini: {
        ...metrics.sessionTelemetry.gemini,
        artifactCount: artifactMetrics.artifactCount,
        artifactPublicEventCount: artifactMetrics.artifactPublicEventCount,
        artifactRuntimeIngestCount: artifactMetrics.artifactRuntimeIngestCount,
        artifactSelectedStageCount: artifactMetrics.artifactSelectedStageCount,
        artifactRenderedCount: artifactMetrics.artifactRenderedCount,
        artifactCountSource: artifactMetrics.artifactCountSource,
        artifactCountMismatch: artifactMetrics.artifactCountMismatch,
        artifactCountMismatchReason: artifactMetrics.artifactCountMismatchReason,
      },
    },
  };
}

function buildCoreviewCommandTelemetryPatch(
  events: CaptureEvent[],
): Partial<CoreviewUsageTelemetry['visual']> {
  const commandPayloads = events
    .filter((event) => event.name === 'artifact-review-voice-command')
    .map((event) => asRecord(event.payload))
    .filter((value): value is Record<string, unknown> => value !== null);
  const latest = commandPayloads.at(-1);

  if (!latest) {
    return {};
  }

  const lastReviewVoiceCommands = commandPayloads.slice(-5).map((payload) => ({
    kind: asString(payload.reviewVoiceCommandKind) ?? asString(payload.lastReviewVoiceCommandKind),
    applied: asBoolean(payload.reviewVoiceCommandApplied) ?? asBoolean(payload.lastReviewVoiceCommandApplied),
    uiMode: asString(payload.lastReviewVoiceCommandUiMode),
    refreshResult: asString(payload.reviewVoiceCommandRefreshResult),
    autoRefreshBlockedReason: asString(payload.reviewVoiceCommandAutoRefreshBlockedReason),
    waitedForViewReady: asBoolean(payload.reviewVoiceCommandWaitedForViewReady),
    didHardIntercept: asBoolean(payload.reviewVoiceCommandDidHardIntercept),
    artifactCurrentPageIndex: asFiniteNumber(payload.artifactCurrentPageIndex),
    artifactCurrentPageCount: asFiniteNumber(payload.artifactCurrentPageCount),
    rawTranscriptExcluded: true as const,
  }));
  const latestSummary = lastReviewVoiceCommands.at(-1);
  const annotationPayloads = commandPayloads.filter((payload) => (
    asString(payload.reviewVoiceCommandKind) === 'add_annotation'
    || asString(payload.lastReviewVoiceCommandKind) === 'add_annotation'
    || asBoolean(payload.annotationCommitAttempted) === true
    || (asFiniteNumber(payload.annotationIntentDetectedCount) ?? 0) > 0
  ));
  const latestAnnotation = annotationPayloads.at(-1);
  const annotationIntentDetectedCount = annotationPayloads.reduce((total, payload) => (
    total + (asFiniteNumber(payload.annotationIntentDetectedCount) ?? 0)
  ), 0);

  const patch: Partial<CoreviewUsageTelemetry['visual']> = {
    reviewCommandStaleAfterViewChange: asBoolean(latest.reviewCommandStaleAfterViewChange)
      ?? asBoolean(latest.reviewCommandStaleAfterPageChange)
      ?? false,
    reviewVoiceCommandTransportStateBefore: asString(latest.reviewVoiceCommandTransportStateBefore),
    reviewVoiceCommandTransportStateAfter: asString(latest.reviewVoiceCommandTransportStateAfter),
    reviewVoiceCommandDidHardIntercept: asBoolean(latest.reviewVoiceCommandDidHardIntercept),
    reviewVoiceCommandWaitedForViewReady: asBoolean(latest.reviewVoiceCommandWaitedForViewReady),
    reviewVoiceCommandAutoRefreshTiming: asString(latest.reviewVoiceCommandAutoRefreshTiming),
    reviewVoiceCommandAutoRefreshBlockedReason: asString(latest.reviewVoiceCommandAutoRefreshBlockedReason),
    lastReviewVoiceCommandKind: latestSummary?.kind ?? null,
    lastReviewVoiceCommandApplied: latestSummary?.applied ?? null,
    lastReviewVoiceCommandUiMode: latestSummary?.uiMode ?? null,
    lastReviewVoiceCommands,
  };

  if (!latestAnnotation) {
    return patch;
  }

  return {
    ...patch,
    annotationIntentDetectedCount,
    annotationIntentSource: asString(latestAnnotation.annotationIntentSource),
    annotationFallbackAttempted: asBoolean(latestAnnotation.annotationFallbackAttempted) ?? false,
    annotationFallbackResult: asString(latestAnnotation.annotationFallbackResult),
    annotationFallbackBlockedReason: asString(latestAnnotation.annotationFallbackBlockedReason),
    annotationFallbackUtteranceKind: asString(latestAnnotation.annotationFallbackUtteranceKind),
    recentAnnotationActionSucceeded: asBoolean(latestAnnotation.recentAnnotationActionSucceeded) ?? false,
    annotationCommitAttempted: asBoolean(latestAnnotation.annotationCommitAttempted) ?? false,
    annotationCommitResult: asString(latestAnnotation.annotationCommitResult),
    annotationCommitCountBefore: asFiniteNumber(latestAnnotation.annotationCommitCountBefore),
    annotationCommitCountAfter: asFiniteNumber(latestAnnotation.annotationCommitCountAfter),
    annotationCommitVerified: asBoolean(latestAnnotation.annotationCommitVerified) ?? false,
    annotationCommandPreventedNavigation: asBoolean(latestAnnotation.annotationCommandPreventedNavigation) ?? false,
    annotationCommandKeptArtifactMounted: asBoolean(latestAnnotation.annotationCommandKeptArtifactMounted) ?? false,
    annotationViewReadyTimedOut: asBoolean(latestAnnotation.annotationViewReadyTimedOut) ?? false,
    annotationPartialSuccess: asBoolean(latestAnnotation.annotationPartialSuccess) ?? false,
    sessionLeaveGuardSuppressedForAnnotation: asBoolean(latestAnnotation.sessionLeaveGuardSuppressedForAnnotation) ?? false,
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
  const directLatestToolExecution = asRecord(diagnostics.latest_tool_execution)
    ?? asRecord(diagnostics.latestToolExecution);

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
      : directLatestToolExecution
        ? compactLatestToolExecution(directLatestToolExecution)
        : null,
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
  if (toolName === GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME) {
    for (const key of READ_ARTIFACT_TEXT_SAFE_TOOL_EXECUTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(latestToolExecution, key)) {
        compact[key] = latestToolExecution[key];
      }
    }
    compact.raw_query_excluded = true;
  }
  if (toolName?.startsWith('coreview_')) {
    for (const key of COREVIEW_SAFE_TOOL_EXECUTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(latestToolExecution, key)) {
        compact[key] = latestToolExecution[key];
      }
    }
    compact.raw_comment_text_excluded = true;
    compact.raw_artifact_text_excluded = true;
    compact.raw_frame_excluded = true;
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
  const maxOrderedRelayQueueDepth = maxNumericField(throughputEntries, 'orderedRelayQueueDepth');
  const maxTranscriptRelayLatencyMs = maxNumericField(throughputEntries, 'maxTranscriptRelayLatencyMs');
  const p95TranscriptRelayLatencyMs = latest ? asFiniteNumber(latest.p95TranscriptRelayLatencyMs) : null;
  const warnings: string[] = [];

  if ((p95TranscriptRelayLatencyMs ?? maxTranscriptRelayLatencyMs ?? 0) >= TRANSCRIPT_RELAY_LATENCY_WARNING_MS) {
    warnings.push('public_transcript_relay_latency_high');
  }
  if ((maxOrderedRelayQueueDepth ?? asFiniteNumber(latest?.orderedRelayQueueDepth) ?? 0) >= ORDERED_RELAY_QUEUE_DEPTH_WARNING) {
    warnings.push('relay_queue_depth_high');
  }

  return {
    schema: 'gemini_relay_throughput_summary_v1',
    warnings,
    relayTraceCountWithThroughput: throughputEntries.length,
    coalescingDiagnosticCount: coalescingDiagnostics.length,
    latestOrderedRelayQueueDepth: latest ? asFiniteNumber(latest.orderedRelayQueueDepth) : null,
    maxOrderedRelayQueueDepth,
    maxOldestQueuedAgeMs: maxNumericField(throughputEntries, 'oldestQueuedAgeMs'),
    transcriptPartialsCoalesced: latest ? asFiniteNumber(latest.transcriptPartialsCoalesced) : null,
    transcriptPartialsSent: latest ? asFiniteNumber(latest.transcriptPartialsSent) : null,
    transcriptPartialsDropped: latest ? asFiniteNumber(latest.transcriptPartialsDropped) : null,
    transcriptCoalescingDisabledReason: latest ? asString(latest.transcriptCoalescingDisabledReason) : null,
    finalTranscriptEventsSent: latest ? asFiniteNumber(latest.finalTranscriptEventsSent) : null,
    nonDroppableCriticalEventsSent: latest ? asFiniteNumber(latest.nonDroppableCriticalEventsSent) : null,
    lastTranscriptRelayLatencyMs: latest ? asFiniteNumber(latest.lastTranscriptRelayLatencyMs) : null,
    maxTranscriptRelayLatencyMs,
    p95TranscriptRelayLatencyMs,
    coalescedBySegment,
  };
}

function buildGeminiStaleOutputDiagnosticsSummary(events: CaptureEvent[]): Record<string, unknown> | null {
  const staleSuppressionDiagnostics = events
    .filter((event) => event.name === 'gemini-stale-output-suppressed')
    .map((event) => asRecord(asRecord(event.payload)?.diagnostic))
    .filter((value): value is Record<string, unknown> => value !== null);
  const inputAudioDiagnostics = events
    .filter((event) => event.name === 'gemini-input-audio-activity')
    .map((event) => asRecord(asRecord(event.payload)?.diagnostic))
    .filter((value): value is Record<string, unknown> => value !== null);
  const bargeInTranscriptDiagnostics = events
    .filter((event) => event.name === 'gemini-barge-in-transcript-handoff')
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
  const bargeInTranscriptCapturedCount = Math.max(
    maxNumericField(bargeInTranscriptDiagnostics, 'bargeInTranscriptCapturedCount') ?? 0,
    bargeInTranscriptDiagnostics.filter((diagnostic) => diagnostic.captured === true).length,
  );
  const bargeInTranscriptPromotedCount = Math.max(
    maxNumericField(bargeInTranscriptDiagnostics, 'bargeInTranscriptPromotedCount') ?? 0,
    bargeInTranscriptDiagnostics.filter((diagnostic) => diagnostic.promoted === true).length,
  );
  const bargeInTranscriptIgnoredCount = Math.max(
    maxNumericField(bargeInTranscriptDiagnostics, 'bargeInTranscriptIgnoredCount') ?? 0,
    bargeInTranscriptDiagnostics.filter((diagnostic) => diagnostic.ignored === true).length,
  );
  const bargeInTranscriptDuplicateSuppressedCount = Math.max(
    maxNumericField(bargeInTranscriptDiagnostics, 'bargeInTranscriptDuplicateSuppressedCount') ?? 0,
    bargeInTranscriptDiagnostics.filter((diagnostic) => diagnostic.duplicateSuppressed === true).length,
  );
  const bargeInNewTurnDispatchCount = Math.max(
    maxNumericField(bargeInTranscriptDiagnostics, 'bargeInNewTurnDispatchCount') ?? 0,
    bargeInTranscriptDiagnostics.filter((diagnostic) => diagnostic.newTurnDispatched === true).length,
  );
  const bargeInNewTurnDispatchBlockedReason = latestStringField(bargeInTranscriptDiagnostics, 'bargeInNewTurnDispatchBlockedReason')
    ?? latestStringField(bargeInTranscriptDiagnostics, 'newTurnDispatchBlockedReason')
    ?? 'none';
  if (bargeInTranscriptCapturedCount > bargeInTranscriptPromotedCount) {
    warnings.push('barge_in_transcript_not_promoted');
  }
  if (bargeInTranscriptPromotedCount > bargeInNewTurnDispatchCount && bargeInNewTurnDispatchBlockedReason !== 'none') {
    warnings.push('barge_in_transcript_dispatch_blocked');
  }
  const bargeInDiagnostics = [...inputAudioDiagnostics, ...staleSuppressionDiagnostics];
  const maxRawAssistantUserOverlapMs = Math.max(
    maxNumericField(bargeInDiagnostics, 'rawAssistantUserOverlapMs') ?? 0,
    maxNumericField(interruptionDiagnostics, 'rawAssistantUserOverlapMs') ?? 0,
    maxNumericField(interruptionDiagnostics, 'assistantUserOverlapMs') ?? 0,
  );
  const maxConfirmedAssistantUserOverlapMs = Math.max(
    maxNumericField(bargeInDiagnostics, 'confirmedAssistantUserOverlapMs') ?? 0,
    maxNumericField(interruptionDiagnostics, 'confirmedAssistantUserOverlapMs') ?? 0,
  );
  const maxAssistantUserOverlapMs = maxRawAssistantUserOverlapMs || maxNumericField(interruptionDiagnostics, 'assistantUserOverlapMs');
  if ((maxAssistantUserOverlapMs ?? 0) >= 1_500) {
    warnings.push('assistant_audio_overlapped_user_input');
  }
  const inputFrameOnlyNotBargeInCount = Math.max(
    maxNumericField(inputAudioDiagnostics, 'inputFrameOnlyNotBargeInCount') ?? 0,
    maxNumericField(staleSuppressionDiagnostics, 'inputFrameOnlyNotBargeInCount') ?? 0,
    inputAudioDiagnostics.filter((diagnostic) => asString(diagnostic.suppressionDeferredReason) === 'input_frame_only_not_barge_in').length,
  );
  const bargeInCandidateFrameCount = maxNumericField(
    bargeInDiagnostics,
    'bargeInCandidateFrameCount',
  );
  const candidateFramesDidNotConfirmCount = maxNumericField(bargeInDiagnostics, 'candidateFramesDidNotConfirmCount') ?? 0;
  const candidateExpiredCount = maxNumericField(bargeInDiagnostics, 'candidateExpiredCount') ?? 0;
  const suppressionBlockedBecauseNoIntentCount = maxNumericField(bargeInDiagnostics, 'suppressionBlockedBecauseNoIntentCount') ?? 0;
  const bargeInConfirmed = staleSuppressionDiagnostics.some((diagnostic) => diagnostic.bargeInConfirmed === true)
    || inputAudioDiagnostics.some((diagnostic) => diagnostic.bargeInConfirmed === true);
  const latestInputAudioDiagnostic = inputAudioDiagnostics.at(-1);
  const latestSuppressedAudioDiagnostic = staleSuppressionDiagnostics
    .filter((diagnostic) => asString(diagnostic.outputType) === 'audio')
    .at(-1);
  const suppressionDeferredReasons = Array.from(new Set(
    inputAudioDiagnostics
      .map((diagnostic) => asString(diagnostic.suppressionDeferredReason))
      .filter((reason): reason is string => reason !== null),
  ));

  if (
    !warnings.length
    && !staleSuppressionDiagnostics.length
    && !bargeInTranscriptDiagnostics.length
    && !staleTranscriptIgnored.length
    && !unresolvedToolEntries.length
    && inputFrameOnlyNotBargeInCount === 0
    && !suppressionDeferredReasons.length
  ) {
    return null;
  }

  return {
    schema: 'gemini_stale_output_diagnostics_summary_v1',
    warnings,
    staleAssistantAudioDroppedCount: staleAudioDroppedCount,
    staleAssistantTranscriptDroppedCount: staleTranscriptDroppedCount,
    staleAssistantOutputSuppressionCount: staleSuppressionDiagnostics.length + staleTranscriptIgnored.length,
    maxAssistantUserOverlapMs,
    maxRawAssistantUserOverlapMs,
    maxConfirmedAssistantUserOverlapMs,
    userInputActiveAgeMs: maxNumericField([...inputAudioDiagnostics, ...staleSuppressionDiagnostics], 'userInputActiveAgeMs'),
    bargeInConfirmed,
    bargeInConfirmationSource: latestStringField(bargeInDiagnostics, 'bargeInConfirmationSource')
      ?? latestStringField(interruptionDiagnostics, 'bargeInConfirmationSource')
      ?? 'none',
    bargeInConfirmationReason: latestStringField(bargeInDiagnostics, 'bargeInConfirmationReason')
      ?? latestStringField(interruptionDiagnostics, 'bargeInConfirmationReason'),
    bargeInCandidateFrameCount,
    candidateFramesDidNotConfirmCount,
    candidateExpiredCount,
    suppressionBlockedBecauseNoIntentCount,
    bargeInTranscriptCapturedCount,
    bargeInTranscriptPromotedCount,
    bargeInTranscriptPromotionLatencyMs: maxNumericField(bargeInTranscriptDiagnostics, 'bargeInTranscriptPromotionLatencyMs')
      ?? maxNumericField(bargeInTranscriptDiagnostics, 'promotionLatencyMs'),
    bargeInTranscriptIgnoredCount,
    bargeInTranscriptDuplicateSuppressedCount,
    lastBargeInTranscriptPreview: latestStringField(bargeInTranscriptDiagnostics, 'lastBargeInTranscriptPreview')
      ?? latestStringField(bargeInTranscriptDiagnostics, 'transcriptPreview'),
    bargeInNewTurnDispatchCount,
    bargeInNewTurnDispatchBlockedReason,
    suppressionDeferredReasons,
    staleSuppressionArmedAt: asString(staleSuppressionDiagnostics.at(-1)?.staleSuppressionArmedAt)
      ?? asString(latestInputAudioDiagnostic?.staleSuppressionArmedAt),
    staleSuppressionArmedBy: asString(staleSuppressionDiagnostics.at(-1)?.staleSuppressionArmedBy),
    assistantAudioDropReason: asString(latestSuppressedAudioDiagnostic?.assistantAudioDropReason)
      ?? asString(latestSuppressedAudioDiagnostic?.reason),
    inputFrameOnlyNotBargeInCount,
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

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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

function latestStringField(values: Record<string, unknown>[], key: string): string | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = asString(values[index]?.[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
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
  selected: ReturnType<typeof selectCurrentRunEvents>,
  metrics: VoiceDeveloperMetrics,
): VoiceTelemetryReport['diagnosticsSummary'] {
  return {
    geminiRelayBackend: buildGeminiRelayBackendDiagnosticsSummary(selected.events),
    geminiRelayThroughput: buildGeminiRelayThroughputSummary(selected.events),
    geminiStaleOutput: buildGeminiStaleOutputDiagnosticsSummary(selected.events),
    builderSurface: buildBuilderSurfaceDiagnosticsSummary(metrics),
    artifactReview: buildArtifactReviewDiagnosticsSummary(selected.events, metrics),
    coreviewStillFrame: buildCoreviewStillFrameDiagnosticsSummary(metrics.coreview),
  };
}

function buildBuilderSurfaceDiagnosticsSummary(metrics: VoiceDeveloperMetrics): Record<string, unknown> {
  return {
    schema: 'builder_surface_summary_v1',
    builderSurfaceMode: metrics.builder.builderSurfaceMode,
    canonicalBuilderSurface: metrics.builder.canonicalBuilderSurface,
    legacyBuilderSurfaceHidden: metrics.builder.legacyBuilderSurfaceHidden,
    builderReadyPillSuppressed: metrics.builder.builderReadyPillSuppressed,
    duplicateBuilderSurfaceSuppressed: metrics.builder.duplicateBuilderSurfaceSuppressed,
    resumedBuilderSurfaceResolved: metrics.builder.resumedBuilderSurfaceResolved,
    completedBuilderEntryPlacement: metrics.builder.completedBuilderEntryPlacement,
    completedBuilderEntryOverlapsControls: metrics.builder.completedBuilderEntryOverlapsControls,
    completedBuilderEntryHiddenForStage: metrics.builder.completedBuilderEntryHiddenForStage,
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
    rawCommentTextExcluded: true,
  };
}

function buildArtifactReviewDiagnosticsSummary(
  events: CaptureEvent[],
  metrics: VoiceDeveloperMetrics,
): Record<string, unknown> {
  const counts = metrics.counts;
  const gemini = metrics.sessionTelemetry.runtime === 'gemini_live'
    ? metrics.sessionTelemetry.gemini
    : null;
  const reviewActive = isArtifactReviewActive(metrics);
  const selectedStageEventCount = events.filter(
    (event) => event.category === 'artifacts-runtime' && event.name === 'select-stage-artifact',
  ).length;
  const suppressedReview = countSuppressedArtifactReviewTools(events);

  return {
    schema: 'artifact_review_summary_v1',
    warnings: buildArtifactReviewWarnings({
      counts,
      emitArtifactToolCallCount: gemini?.artifactToolCallCount ?? 0,
      reviewActive,
      artifactRebindResult: metrics.coreview.visual.artifactRebindResult,
      suppressedReviewEmitToolCount: suppressedReview.emitArtifactCount,
      suppressedReviewToolCount: suppressedReview.totalCount,
      toolRejectionCount: gemini?.toolRejectionCount ?? 0,
    }),
    reviewActive,
    artifactCount: counts.artifacts,
    artifactPublicEventCount: counts.artifactPublicEventCount,
    artifactRuntimeIngestCount: counts.artifactRuntimeIngestCount,
    artifactSelectedStageCount: counts.artifactSelectedStageCount,
    artifactRenderedCount: counts.artifactRenderedCount,
    artifactCountSource: counts.artifactCountSource,
    artifactCountMismatch: counts.artifactCountMismatch,
    artifactCountMismatchReason: counts.artifactCountMismatchReason,
    selectedStageEventCount,
    currentRunSelectedStageEvents: metrics.coreview.visual.currentRunSelectedStageEvents,
    longLivedSelectedStageState: metrics.coreview.visual.longLivedSelectedStageState,
    telemetryScopeMode: metrics.coreview.visual.telemetryScopeMode,
    artifactStableIdentity: metrics.coreview.visual.artifactStableIdentity,
    artifactRebindAttempted: metrics.coreview.visual.artifactRebindAttempted,
    artifactRebindResult: metrics.coreview.visual.artifactRebindResult,
    artifactRebindReason: metrics.coreview.visual.artifactRebindReason,
    artifactReboundFromRenderedState: metrics.coreview.visual.artifactReboundFromRenderedState,
    artifactRebindSource: metrics.coreview.visual.artifactRebindSource,
    exactTextRehydrated: metrics.coreview.visual.exactTextRehydrated,
    exactTextRehydrateResult: metrics.coreview.visual.exactTextRehydrateResult,
    emitArtifactToolCallCount: gemini?.artifactToolCallCount ?? 0,
    emitArtifactBlockedDuringReviewCount: suppressedReview.emitArtifactCount,
    emitArtifactBlockedForAnnotationIntentCount: metrics.coreview.visual.emitArtifactBlockedForAnnotationIntentCount,
    toolRejectionCount: gemini?.toolRejectionCount ?? 0,
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
  };
}

function isArtifactReviewActive(metrics: VoiceDeveloperMetrics): boolean {
  return Boolean(
    metrics.coreview.visual.coreviewEnabled
      && (
        metrics.coreview.visual.coreviewArtifactId
        || metrics.coreview.visual.frameSentCount > 0
        || metrics.counts.artifactSelectedStageCount > 0
      ),
  );
}

function countSuppressedArtifactReviewTools(events: CaptureEvent[]): {
  emitArtifactCount: number;
  totalCount: number;
} {
  let emitArtifactCount = 0;
  let totalCount = 0;

  for (const event of events) {
    const toolName = suppressedArtifactReviewToolName(event);
    if (toolName === null) {
      continue;
    }
    totalCount += 1;
    if (toolName === 'emit_artifact') {
      emitArtifactCount += 1;
    }
  }

  return { emitArtifactCount, totalCount };
}

function suppressedArtifactReviewToolName(event: CaptureEvent): string | null {
  if (event.category !== 'voice-session' || event.name !== 'gemini-tool-loop-diagnostic') {
    return null;
  }
  const payload = asRecord(event.payload);
  const data = asRecord(payload?.data) ?? payload;
  if (asString(data?.phase) !== 'tool_execution_rejected') {
    return null;
  }
  const diagnostic = asRecord(data?.diagnostic);
  const toolCall = asRecord(diagnostic?.toolCall);
  const rejectionReason = asString(data?.rejectionReason)
    ?? asString(diagnostic?.rejectionReason)
    ?? asString(diagnostic?.rejection_reason);
  if (rejectionReason !== 'artifact_review_emit_artifact_suppressed') {
    return null;
  }
  return asString(data?.toolName ?? toolCall?.name);
}

function buildArtifactReviewWarnings({
  counts,
  emitArtifactToolCallCount,
  reviewActive,
  artifactRebindResult,
  suppressedReviewEmitToolCount,
  suppressedReviewToolCount,
  toolRejectionCount,
}: {
  counts: VoiceDeveloperMetrics['counts'];
  emitArtifactToolCallCount: number;
  reviewActive: boolean;
  artifactRebindResult?: string | null;
  suppressedReviewEmitToolCount: number;
  suppressedReviewToolCount: number;
  toolRejectionCount: number;
}): string[] {
  const warnings: string[] = [];

  if (
    counts.artifactRenderedCount > 0
    && counts.artifactRuntimeIngestCount === 0
    && artifactRebindResult !== 'success'
  ) {
    warnings.push('artifact_rendered_not_runtime_ingested');
  }
  if (counts.artifactCountMismatch) {
    warnings.push('artifact_count_mismatch');
  }
  if (reviewActive && emitArtifactToolCallCount > suppressedReviewEmitToolCount) {
    warnings.push('review_emit_artifact_tool_churn_detected');
  }
  if (reviewActive && toolRejectionCount > suppressedReviewToolCount) {
    warnings.push('review_tool_churn_suppressed');
  }

  return warnings;
}

function buildCoreviewStillFrameDiagnosticsSummary(coreview: CoreviewUsageTelemetry): Record<string, unknown> {
  return {
    schema: 'coreview_still_frame_summary_v1',
    coreviewEnabled: coreview.visual.coreviewEnabled,
    frontendCoreviewFlagParsed: coreview.visual.frontendCoreviewFlagParsed,
    frontendStillFrameFlagParsed: coreview.visual.frontendStillFrameFlagParsed,
    backendCoreviewFlagParsed: coreview.visual.backendCoreviewFlagParsed,
    backendStillFrameFlagParsed: coreview.visual.backendStillFrameFlagParsed,
    coreviewDisabledReason: coreview.visual.coreviewDisabledReason,
    reviewStartBlockedReason: coreview.visual.reviewStartBlockedReason,
    coreviewSessionActive: coreview.visual.coreviewSessionActive,
    coreviewArtifactId: coreview.visual.coreviewArtifactId,
    coreviewWorkspaceContractVersion: coreview.visual.coreviewWorkspaceContractVersion,
    artifactStableIdentity: coreview.visual.artifactStableIdentity,
    artifactCapabilityRendererKind: coreview.visual.artifactCapabilityRendererKind,
    artifactCapabilityRenderMode: coreview.visual.artifactCapabilityRenderMode,
    artifactCapabilitySupportsPages: coreview.visual.artifactCapabilitySupportsPages,
    artifactCapabilitySupportsAnnotations: coreview.visual.artifactCapabilitySupportsAnnotations,
    artifactCapabilitySupportsTextExtraction: coreview.visual.artifactCapabilitySupportsTextExtraction,
    artifactCapabilitySupportsLayoutAnchors: coreview.visual.artifactCapabilitySupportsLayoutAnchors,
    artifactCapabilitySupportsOCR: coreview.visual.artifactCapabilitySupportsOCR,
    artifactCapabilityRequiresOCR: coreview.visual.artifactCapabilityRequiresOCR,
    artifactCapabilitySupportsPptxNativeRender: coreview.visual.artifactCapabilitySupportsPptxNativeRender,
    artifactCapabilitySupportsAnnotatedExport: coreview.visual.artifactCapabilitySupportsAnnotatedExport,
    artifactCapabilityFallbackReason: coreview.visual.artifactCapabilityFallbackReason,
    coreviewWorkspaceEventLogActive: coreview.visual.coreviewWorkspaceEventLogActive,
    coreviewWorkspaceEventCount: coreview.visual.coreviewWorkspaceEventCount,
    coreviewWorkspaceLastEventType: coreview.visual.coreviewWorkspaceLastEventType,
    coreviewWorkspaceActorKind: coreview.visual.coreviewWorkspaceActorKind,
    coreviewWorkspaceHasShareReadyMetadata: coreview.visual.coreviewWorkspaceHasShareReadyMetadata,
    coreviewShareStatus: coreview.visual.coreviewShareStatus,
    workspaceEventLogPersistResult: coreview.visual.workspaceEventLogPersistResult,
    workspaceEventLogRestoreCount: coreview.visual.workspaceEventLogRestoreCount,
    annotationEventsCreatedCount: coreview.visual.annotationEventsCreatedCount,
    viewChangedEventCount: coreview.visual.viewChangedEventCount,
    builderWorkspaceEventCount: coreview.visual.builderWorkspaceEventCount,
    builderLastWorkspaceEventType: coreview.visual.builderLastWorkspaceEventType,
    coreviewBuilderActionsEnabled: coreview.visual.coreviewBuilderActionsEnabled,
    coreviewBuilderActionsBlockedReason: coreview.visual.coreviewBuilderActionsBlockedReason,
    coreviewBuilderToolsExposed: coreview.visual.coreviewBuilderToolsExposed,
    coreviewBuilderGenericToolsSuppressed: coreview.visual.coreviewBuilderGenericToolsSuppressed,
    coreviewBuilderActiveTaskState: coreview.visual.coreviewBuilderActiveTaskState,
    coreviewBuilderUpdateIntentDetected: coreview.visual.coreviewBuilderUpdateIntentDetected,
    coreviewBuilderUpdateAttempted: coreview.visual.coreviewBuilderUpdateAttempted,
    coreviewBuilderUpdateResult: coreview.visual.coreviewBuilderUpdateResult,
    coreviewBuilderUpdateBlockedReason: coreview.visual.coreviewBuilderUpdateBlockedReason,
    coreviewBuilderUpdateMode: coreview.visual.coreviewBuilderUpdateMode,
    coreviewBuilderUpdateArtifactContextPresent: coreview.visual.coreviewBuilderUpdateArtifactContextPresent,
    coreviewBuilderTaskStarted: coreview.visual.coreviewBuilderTaskStarted,
    coreviewBuilderTaskIdPresent: coreview.visual.coreviewBuilderTaskIdPresent,
    coreviewBuilderCancelIntentDetected: coreview.visual.coreviewBuilderCancelIntentDetected,
    coreviewBuilderCancelAttempted: coreview.visual.coreviewBuilderCancelAttempted,
    coreviewBuilderCancelResult: coreview.visual.coreviewBuilderCancelResult,
    coreviewBuilderCancelBlockedReason: coreview.visual.coreviewBuilderCancelBlockedReason,
    coreviewBuilderStatusResult: coreview.visual.coreviewBuilderStatusResult,
    coreviewBuilderStatusToolResult: coreview.visual.coreviewBuilderStatusToolResult,
    editBuilderArtifactInterceptedByCoreview: coreview.visual.editBuilderArtifactInterceptedByCoreview,
    editBuilderArtifactDirectCallResult: coreview.visual.editBuilderArtifactDirectCallResult,
    coreviewUpdateStateCreatedFromDirectEditTool: coreview.visual.coreviewUpdateStateCreatedFromDirectEditTool,
    coreviewUpdateCardVisible: coreview.visual.coreviewUpdateCardVisible,
    genericAsyncToolBlockedReason: coreview.visual.genericAsyncToolBlockedReason,
    genericAsyncToolRespondedSafely: coreview.visual.genericAsyncToolRespondedSafely,
    coreviewBuilderPreservedMic: coreview.visual.coreviewBuilderPreservedMic,
    coreviewBuilderPreservedReview: coreview.visual.coreviewBuilderPreservedReview,
    coreviewHtmlLiveUpdateEnabled: coreview.visual.coreviewHtmlLiveUpdateEnabled,
    coreviewArtifactVersioningEnabled: coreview.visual.coreviewArtifactVersioningEnabled,
    coreviewArtifactLogicalId: coreview.visual.coreviewArtifactLogicalId,
    coreviewArtifactOriginalVersionIdPresent: coreview.visual.coreviewArtifactOriginalVersionIdPresent,
    coreviewArtifactCurrentVersionIdPresent: coreview.visual.coreviewArtifactCurrentVersionIdPresent,
    coreviewArtifactVersionCount: coreview.visual.coreviewArtifactVersionCount,
    coreviewHtmlUpdateMatchedBy: coreview.visual.coreviewHtmlUpdateMatchedBy,
    coreviewHtmlUpdateAutoApplyAttempted: coreview.visual.coreviewHtmlUpdateAutoApplyAttempted,
    coreviewHtmlUpdateAutoApplied: coreview.visual.coreviewHtmlUpdateAutoApplied,
    coreviewHtmlUpdateAutoApplyResult: coreview.visual.coreviewHtmlUpdateAutoApplyResult,
    coreviewHtmlUpdateRenderConfirmed: coreview.visual.coreviewHtmlUpdateRenderConfirmed,
    coreviewHtmlUpdatePreviewRefreshFailed: coreview.visual.coreviewHtmlUpdatePreviewRefreshFailed,
    coreviewHtmlUpdatePreviousPathHash: coreview.visual.coreviewHtmlUpdatePreviousPathHash,
    coreviewHtmlUpdateCurrentPathHash: coreview.visual.coreviewHtmlUpdateCurrentPathHash,
    coreviewHtmlUpdateRestoreAvailable: coreview.visual.coreviewHtmlUpdateRestoreAvailable,
    coreviewHtmlUpdateRestoreResult: coreview.visual.coreviewHtmlUpdateRestoreResult,
    coreviewHtmlUpdateNoViewClickRequired: coreview.visual.coreviewHtmlUpdateNoViewClickRequired,
    coreviewHtmlUpdateSuppressedCompletedBuilderSurface: coreview.visual.coreviewHtmlUpdateSuppressedCompletedBuilderSurface,
    coreviewHtmlUpdateSuppressedDuplicateReplyCount: coreview.visual.coreviewHtmlUpdateSuppressedDuplicateReplyCount,
    coreviewHtmlUpdateSuccessClaimBlockedUntilRender: coreview.visual.coreviewHtmlUpdateSuccessClaimBlockedUntilRender,
    coreviewHtmlUpdateSelectedPathChanged: coreview.visual.coreviewHtmlUpdateSelectedPathChanged,
    coreviewHtmlUpdatePreservedReview: coreview.visual.coreviewHtmlUpdatePreservedReview,
    coreviewHtmlUpdatePreservedMic: coreview.visual.coreviewHtmlUpdatePreservedMic,
    coreviewHtmlQuickPatchEligible: coreview.visual.coreviewHtmlQuickPatchEligible,
    coreviewHtmlQuickPatchAttempted: coreview.visual.coreviewHtmlQuickPatchAttempted,
    coreviewHtmlQuickPatchResult: coreview.visual.coreviewHtmlQuickPatchResult,
    coreviewHtmlQuickPatchKind: coreview.visual.coreviewHtmlQuickPatchKind,
    coreviewHtmlQuickPatchFallbackReason: coreview.visual.coreviewHtmlQuickPatchFallbackReason,
    coreviewHtmlQuickPatchLatencyMs: coreview.visual.coreviewHtmlQuickPatchLatencyMs,
    coreviewHtmlQuickPatchRevisionPathHash: coreview.visual.coreviewHtmlQuickPatchRevisionPathHash,
    coreviewHtmlQuickPatchUsedFullBuilder: coreview.visual.coreviewHtmlQuickPatchUsedFullBuilder,
    coreviewHtmlQuickPatchRenderConfirmed: coreview.visual.coreviewHtmlQuickPatchRenderConfirmed,
    coreviewHtmlQuickPatchPreservedOriginal: coreview.visual.coreviewHtmlQuickPatchPreservedOriginal,
    coreviewHtmlQuickPatchRestoreAvailable: coreview.visual.coreviewHtmlQuickPatchRestoreAvailable,
    coreviewHtmlQuickPatchTypeErrorPrevented: coreview.visual.coreviewHtmlQuickPatchTypeErrorPrevented,
    coreviewActionFeedbackEmitted: coreview.visual.coreviewActionFeedbackEmitted,
    coreviewActionFeedbackKind: coreview.visual.coreviewActionFeedbackKind,
    coreviewActionFeedbackStatus: coreview.visual.coreviewActionFeedbackStatus,
    coreviewActionFeedbackSpoken: coreview.visual.coreviewActionFeedbackSpoken,
    coreviewActionFeedbackAudioAttempted: coreview.visual.coreviewActionFeedbackAudioAttempted,
    coreviewActionFeedbackAudioResult: coreview.visual.coreviewActionFeedbackAudioResult,
    coreviewActionFeedbackDedupeSuppressedCount: coreview.visual.coreviewActionFeedbackDedupeSuppressedCount,
    coreviewActionFeedbackRawContentExcluded: coreview.visual.coreviewActionFeedbackRawContentExcluded,
    voiceAudioAckUnavailable: coreview.visual.voiceAudioAckUnavailable,
    htmlCaptureTargetRegistered: coreview.visual.htmlCaptureTargetRegistered,
    htmlCaptureTargetRegistrationResult: coreview.visual.htmlCaptureTargetRegistrationResult,
    htmlCaptureTargetArtifactPathHash: coreview.visual.htmlCaptureTargetArtifactPathHash,
    htmlCaptureTargetStableIdentityHash: coreview.visual.htmlCaptureTargetStableIdentityHash,
    htmlCaptureTargetVersionAware: coreview.visual.htmlCaptureTargetVersionAware,
    htmlCaptureTargetRebindCount: coreview.visual.htmlCaptureTargetRebindCount,
    htmlCaptureTargetMissingBeforeRetry: coreview.visual.htmlCaptureTargetMissingBeforeRetry,
    htmlCaptureTargetRetryAttempted: coreview.visual.htmlCaptureTargetRetryAttempted,
    htmlCaptureTargetRetryResult: coreview.visual.htmlCaptureTargetRetryResult,
    htmlCaptureTargetReadyLatencyMs: coreview.visual.htmlCaptureTargetReadyLatencyMs,
    htmlFrameCaptureSourceKind: coreview.visual.htmlFrameCaptureSourceKind,
    htmlFrameCaptureSucceeded: coreview.visual.htmlFrameCaptureSucceeded,
    htmlFrameCaptureFailureReason: coreview.visual.htmlFrameCaptureFailureReason,
    htmlVisiblePreviewResponsive: coreview.visual.htmlVisiblePreviewResponsive,
    htmlVisiblePreviewUsesCaptureDimensions: coreview.visual.htmlVisiblePreviewUsesCaptureDimensions,
    htmlVisiblePreviewWidth: coreview.visual.htmlVisiblePreviewWidth,
    htmlVisiblePreviewHeight: coreview.visual.htmlVisiblePreviewHeight,
    htmlVisiblePreviewScrollMode: coreview.visual.htmlVisiblePreviewScrollMode,
    htmlVisibleRendererKind: coreview.visual.htmlVisibleRendererKind,
    htmlVisibleRendererInteractive: coreview.visual.htmlVisibleRendererInteractive,
    htmlVisibleIframePointerEvents: coreview.visual.htmlVisibleIframePointerEvents,
    htmlOverlayPointerEventsMode: coreview.visual.htmlOverlayPointerEventsMode,
    htmlOffscreenCaptureAffectsLayout: coreview.visual.htmlOffscreenCaptureAffectsLayout,
    htmlScrollMode: coreview.visual.htmlScrollMode,
    htmlScrollContainerResolved: coreview.visual.htmlScrollContainerResolved,
    htmlScrollTop: coreview.visual.htmlScrollTop,
    htmlScrollHeight: coreview.visual.htmlScrollHeight,
    htmlViewportHeight: coreview.visual.htmlViewportHeight,
    htmlScrollAttempted: coreview.visual.htmlScrollAttempted,
    htmlScrollResult: coreview.visual.htmlScrollResult,
    htmlFocusAnchorAttempted: coreview.visual.htmlFocusAnchorAttempted,
    htmlFocusAnchorResult: coreview.visual.htmlFocusAnchorResult,
    htmlFocusAnchorMethod: coreview.visual.htmlFocusAnchorMethod,
    htmlFocusAnchorScrolled: coreview.visual.htmlFocusAnchorScrolled,
    htmlInternalNavigationAttempted: coreview.visual.htmlInternalNavigationAttempted,
    htmlInternalNavigationResult: coreview.visual.htmlInternalNavigationResult,
    htmlInternalNavigationTargetKind: coreview.visual.htmlInternalNavigationTargetKind,
    htmlInternalNavigationPreventedDefault: coreview.visual.htmlInternalNavigationPreventedDefault,
    htmlInternalNavigationBlockedExternal: coreview.visual.htmlInternalNavigationBlockedExternal,
    htmlInternalNavigationScrolled: coreview.visual.htmlInternalNavigationScrolled,
    htmlInternalNavigationFailureReason: coreview.visual.htmlInternalNavigationFailureReason,
    htmlVoiceNavigationUsedSameResolver: coreview.visual.htmlVoiceNavigationUsedSameResolver,
    htmlPostMessageNavigationReceived: coreview.visual.htmlPostMessageNavigationReceived,
    htmlNavigationPreservedCaptureTarget: coreview.visual.htmlNavigationPreservedCaptureTarget,
    htmlAnnotationOverlayCapturing: coreview.visual.htmlAnnotationOverlayCapturing,
    htmlBrowserInteractionEnabled: coreview.visual.htmlBrowserInteractionEnabled,
    htmlPageRailHidden: coreview.visual.htmlPageRailHidden,
    htmlThumbnailRailHidden: coreview.visual.htmlThumbnailRailHidden,
    htmlCoreviewCommandModel: coreview.visual.htmlCoreviewCommandModel,
    htmlFitModeApplied: coreview.visual.htmlFitModeApplied,
    htmlZoomScale: coreview.visual.htmlZoomScale,
    htmlReviewStatusResolved: coreview.visual.htmlReviewStatusResolved,
    htmlReviewStatusReason: coreview.visual.htmlReviewStatusReason,
    reviewStartWaitedForHtmlCaptureTarget: coreview.visual.reviewStartWaitedForHtmlCaptureTarget,
    reviewStartHtmlCaptureTargetResult: coreview.visual.reviewStartHtmlCaptureTargetResult,
    artifactRebindAttempted: coreview.visual.artifactRebindAttempted,
    artifactRebindResult: coreview.visual.artifactRebindResult,
    artifactRebindReason: coreview.visual.artifactRebindReason,
    artifactReboundFromRenderedState: coreview.visual.artifactReboundFromRenderedState,
    artifactRebindSource: coreview.visual.artifactRebindSource,
    exactTextRehydrated: coreview.visual.exactTextRehydrated,
    exactTextRehydrateResult: coreview.visual.exactTextRehydrateResult,
    currentRunSelectedStageEvents: coreview.visual.currentRunSelectedStageEvents,
    longLivedSelectedStageState: coreview.visual.longLivedSelectedStageState,
    telemetryScopeMode: coreview.visual.telemetryScopeMode,
    canvasRestoreAttempted: coreview.visual.canvasRestoreAttempted,
    canvasRestoreResult: coreview.visual.canvasRestoreResult,
    canvasRestoreSource: coreview.visual.canvasRestoreSource,
    canvasRestoredArtifactIdentityHash: coreview.visual.canvasRestoredArtifactIdentityHash,
    visualSourceKind: coreview.visual.visualSourceKind,
    frameSentCount: coreview.visual.frameSentCount,
    initialFrameSent: coreview.visual.initialFrameSent,
    frameSendFailureCount: coreview.visual.frameSendFailureCount,
    lastFrameSendFailureReason: coreview.visual.lastFrameSendFailureReason,
    lastFrameDimensions: coreview.visual.lastFrameDimensions,
    lastFrameBytes: coreview.visual.lastFrameBytes,
    visualFresh: coreview.visual.visualFresh,
    visualFreshForTurn: coreview.visual.visualFreshForTurn,
    exactTextAvailable: coreview.visual.exactTextAvailable,
    reviewCommandPreservedMic: coreview.visual.reviewCommandPreservedMic,
    reviewCommandPreservedReview: coreview.visual.reviewCommandPreservedReview,
    reviewCommandAutoRefreshAttempted: coreview.visual.reviewCommandAutoRefreshAttempted,
    reviewCommandAutoRefreshResult: coreview.visual.reviewCommandAutoRefreshResult,
    reviewCommandStaleAfterPageChange: coreview.visual.reviewCommandStaleAfterPageChange,
    reviewCommandStaleAfterViewChange: coreview.visual.reviewCommandStaleAfterViewChange,
    reviewVoiceCommandTransportStateBefore: coreview.visual.reviewVoiceCommandTransportStateBefore,
    reviewVoiceCommandTransportStateAfter: coreview.visual.reviewVoiceCommandTransportStateAfter,
    reviewVoiceCommandDidHardIntercept: coreview.visual.reviewVoiceCommandDidHardIntercept,
    reviewVoiceCommandWaitedForViewReady: coreview.visual.reviewVoiceCommandWaitedForViewReady,
    reviewVoiceCommandAutoRefreshTiming: coreview.visual.reviewVoiceCommandAutoRefreshTiming,
    reviewVoiceCommandAutoRefreshBlockedReason: coreview.visual.reviewVoiceCommandAutoRefreshBlockedReason,
    telemetryExportAfterCommandSucceeded: coreview.visual.telemetryExportAfterCommandSucceeded,
    lastReviewVoiceCommandKind: coreview.visual.lastReviewVoiceCommandKind,
    lastReviewVoiceCommandApplied: coreview.visual.lastReviewVoiceCommandApplied,
    lastReviewVoiceCommandUiMode: coreview.visual.lastReviewVoiceCommandUiMode,
    lastReviewVoiceCommands: coreview.visual.lastReviewVoiceCommands,
    pdfTextExtractionStatus: coreview.visual.pdfTextExtractionStatus,
    pdfTextExtractionPageCount: coreview.visual.pdfTextExtractionPageCount,
    pdfTextExtractionCharCount: coreview.visual.pdfTextExtractionCharCount,
    pdfTextExtractionSource: coreview.visual.pdfTextExtractionSource,
    annotationOverlayCaptured: coreview.visual.annotationOverlayCaptured,
    annotationCount: coreview.visual.annotationCount,
    highlightCount: coreview.visual.highlightCount,
    commentCount: coreview.visual.commentCount,
    underlineCount: coreview.visual.underlineCount,
    arrowCount: coreview.visual.arrowCount,
    drawPathCount: coreview.visual.drawPathCount,
    annotationPersistenceStatus: coreview.visual.annotationPersistenceStatus,
    annotationRestoreAttempted: coreview.visual.annotationRestoreAttempted,
    annotationRestoreResult: coreview.visual.annotationRestoreResult,
    annotationRestoreCount: coreview.visual.annotationRestoreCount,
    annotationRestoreSource: coreview.visual.annotationRestoreSource,
    annotationPersistAttempted: coreview.visual.annotationPersistAttempted,
    annotationPersistResult: coreview.visual.annotationPersistResult,
    annotationPersistCount: coreview.visual.annotationPersistCount,
    annotationPersistedCount: coreview.visual.annotationPersistedCount,
    annotationStorageVersion: coreview.visual.annotationStorageVersion,
    annotationStorageKeyHash: coreview.visual.annotationStorageKeyHash,
    annotationIdentityWriteHash: coreview.visual.annotationIdentityWriteHash,
    annotationIdentityReadHash: coreview.visual.annotationIdentityReadHash,
    annotationRestoreOverwrittenCount: coreview.visual.annotationRestoreOverwrittenCount,
    coreviewAnnotationStoreActive: coreview.visual.coreviewAnnotationStoreActive,
    coreviewAnnotationStateSource: coreview.visual.coreviewAnnotationStateSource,
    annotationPreventedEmptyOverwriteCount: coreview.visual.annotationPreventedEmptyOverwriteCount,
    annotationMigratedIdentityCount: coreview.visual.annotationMigratedIdentityCount,
    annotationStoreSurvivedCanvasClose: coreview.visual.annotationStoreSurvivedCanvasClose,
    annotationStoreHydratedArtifactStage: coreview.visual.annotationStoreHydratedArtifactStage,
    annotationStateClearedReason: coreview.visual.annotationStateClearedReason,
    builderSnapshotIgnoredForActiveArtifact: coreview.visual.builderSnapshotIgnoredForActiveArtifact,
    builderSnapshotEmptyPassive: coreview.visual.builderSnapshotEmptyPassive,
    artifactStageProtectedFromSnapshot: coreview.visual.artifactStageProtectedFromSnapshot,
    artifactStageUnmountPrevented: coreview.visual.artifactStageUnmountPrevented,
    thumbnailAnnotationIndicatorMode: coreview.visual.thumbnailAnnotationIndicatorMode,
    thumbnailAnnotationPageCounts: coreview.visual.thumbnailAnnotationPageCounts,
    thumbnailAnnotationRefreshCount: coreview.visual.thumbnailAnnotationRefreshCount,
    canvasPointerBlockedAfterAnnotation: coreview.visual.canvasPointerBlockedAfterAnnotation,
    stickyToolModeEnabled: coreview.visual.stickyToolModeEnabled,
    lastToolModeBeforeAction: coreview.visual.lastToolModeBeforeAction,
    lastToolModeAfterAction: coreview.visual.lastToolModeAfterAction,
    toolModeResetReason: coreview.visual.toolModeResetReason,
    annotationExportAvailable: coreview.visual.annotationExportAvailable,
    annotationExportResult: coreview.visual.annotationExportResult,
    annotationExportKind: coreview.visual.annotationExportKind,
    annotationExportPageScope: coreview.visual.annotationExportPageScope,
    annotationDeleteCount: coreview.visual.annotationDeleteCount,
    annotationEditCount: coreview.visual.annotationEditCount,
    unsupportedAnnotationKind: coreview.visual.unsupportedAnnotationKind,
    annotationActionSource: coreview.visual.annotationActionSource,
    coreviewAnnotationToolCount: coreview.visual.coreviewAnnotationToolCount,
    coreviewAnnotationFallbackCount: coreview.visual.coreviewAnnotationFallbackCount,
    coreviewAnnotationCommandSource: coreview.visual.coreviewAnnotationCommandSource,
    coreviewAnnotationToolResult: coreview.visual.coreviewAnnotationToolResult,
    coreviewAnnotationFallbackResult: coreview.visual.coreviewAnnotationFallbackResult,
    coreviewAnnotationKind: coreview.visual.coreviewAnnotationKind,
    coreviewAnnotationAnchorType: coreview.visual.coreviewAnnotationAnchorType,
    coreviewAnnotationColor: coreview.visual.coreviewAnnotationColor,
    coreviewAnnotationPageIndex: coreview.visual.coreviewAnnotationPageIndex,
    coreviewAnnotationBlockedReason: coreview.visual.coreviewAnnotationBlockedReason,
    coreviewHtmlAnnotationsEnabled: coreview.visual.coreviewHtmlAnnotationsEnabled,
    coreviewHtmlAnnotationKind: coreview.visual.coreviewHtmlAnnotationKind,
    coreviewHtmlAnnotationAnchorType: coreview.visual.coreviewHtmlAnnotationAnchorType,
    coreviewHtmlAnnotationResult: coreview.visual.coreviewHtmlAnnotationResult,
    coreviewHtmlAnnotationPersisted: coreview.visual.coreviewHtmlAnnotationPersisted,
    annotationIntentDetectedCount: coreview.visual.annotationIntentDetectedCount,
    annotationIntentSource: coreview.visual.annotationIntentSource,
    annotationFallbackAttempted: coreview.visual.annotationFallbackAttempted,
    annotationFallbackResult: coreview.visual.annotationFallbackResult,
    annotationFallbackBlockedReason: coreview.visual.annotationFallbackBlockedReason,
    annotationFallbackUtteranceKind: coreview.visual.annotationFallbackUtteranceKind,
    recentAnnotationActionSucceeded: coreview.visual.recentAnnotationActionSucceeded,
    annotationCommitAttempted: coreview.visual.annotationCommitAttempted,
    annotationCommitResult: coreview.visual.annotationCommitResult,
    annotationCommitCountBefore: coreview.visual.annotationCommitCountBefore,
    annotationCommitCountAfter: coreview.visual.annotationCommitCountAfter,
    annotationCommitVerified: coreview.visual.annotationCommitVerified,
    annotationCommandPreventedNavigation: coreview.visual.annotationCommandPreventedNavigation,
    annotationCommandKeptArtifactMounted: coreview.visual.annotationCommandKeptArtifactMounted,
    annotationViewReadyTimedOut: coreview.visual.annotationViewReadyTimedOut,
    annotationPartialSuccess: coreview.visual.annotationPartialSuccess,
    sessionLeaveGuardSuppressedForAnnotation: coreview.visual.sessionLeaveGuardSuppressedForAnnotation,
    assistantAnnotationClaimSuppressedCount: coreview.visual.assistantAnnotationClaimSuppressedCount,
    coreviewFocusAnchorCount: coreview.visual.coreviewFocusAnchorCount,
    coreviewFocusAnchorResult: coreview.visual.coreviewFocusAnchorResult,
    coreviewFocusAnchorType: coreview.visual.coreviewFocusAnchorType,
    keyboardArtifactShortcutUsed: coreview.visual.keyboardArtifactShortcutUsed,
    pinchZoomUsed: coreview.visual.pinchZoomUsed,
    panModeActive: coreview.visual.panModeActive,
    panGestureCount: coreview.visual.panGestureCount,
    panGestureResult: coreview.visual.panGestureResult,
    panScrollDeltaX: coreview.visual.panScrollDeltaX,
    panScrollDeltaY: coreview.visual.panScrollDeltaY,
    coreviewToolCompletedCount: coreview.visual.coreviewToolCompletedCount,
    coreviewToolUnresolvedCount: coreview.visual.coreviewToolUnresolvedCount,
    coreviewToolLastResult: coreview.visual.coreviewToolLastResult,
    coreviewToolRefreshResult: coreview.visual.coreviewToolRefreshResult,
    coreviewToolVisualFreshAfterResult: coreview.visual.coreviewToolVisualFreshAfterResult,
    reviewToolsExposed: coreview.visual.reviewToolsExposed,
    emitArtifactExposedDuringReview: coreview.visual.emitArtifactExposedDuringReview,
    reviewToolTimedOut: coreview.visual.reviewToolTimedOut,
    reviewToolTimeoutName: coreview.visual.reviewToolTimeoutName,
    reviewToolTimeoutResultSent: coreview.visual.reviewToolTimeoutResultSent,
    coreviewGetCurrentViewCount: coreview.visual.coreviewGetCurrentViewCount,
    coreviewGetCurrentViewResult: coreview.visual.coreviewGetCurrentViewResult,
    providerToPublicTranscriptGapAfterCoreviewTool: coreview.visual.providerToPublicTranscriptGapAfterCoreviewTool,
    followUpTurnDispatchedAfterCoreviewTool: coreview.visual.followUpTurnDispatchedAfterCoreviewTool,
    emitArtifactBlockedDuringReviewCount: coreview.visual.emitArtifactBlockedDuringReviewCount,
    emitArtifactBlockedForAnnotationIntentCount: coreview.visual.emitArtifactBlockedForAnnotationIntentCount,
    exactTextCallCount: coreview.exactText.exactTextCallCount,
    exactTextSuccessCount: coreview.exactText.exactTextSuccessCount,
    readArtifactTextCallCount: coreview.exactText.readArtifactTextCallCount,
    readArtifactTextResolvedCount: coreview.exactText.readArtifactTextResolvedCount,
    readArtifactTextUnresolvedCount: coreview.exactText.readArtifactTextUnresolvedCount,
    readArtifactTextTimeoutCount: coreview.exactText.readArtifactTextTimeoutCount,
    readArtifactTextLastStatus: coreview.exactText.readArtifactTextLastStatus,
    readArtifactTextPdfExtractionStatus: coreview.exactText.readArtifactTextPdfExtractionStatus,
    exactTextRegistrySource: coreview.exactText.exactTextRegistrySource,
    rawFrameExcluded: coreview.visual.rawFrameExcluded,
    rawProviderPayloadExcluded: coreview.visual.rawProviderPayloadExcluded,
    rawArtifactTextExcluded: coreview.exactText.rawArtifactTextExcluded,
    rawCommentTextExcluded: coreview.visual.rawCommentTextExcluded,
  };
}

function compactTelemetryCaptureEvent(event: CaptureEvent): CaptureEvent {
  if (event.name === 'gemini-artifact-frame-send') {
    return compactCoreviewFrameEvent(event);
  }
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

function compactCoreviewFrameEvent(event: CaptureEvent): CaptureEvent {
  const payload = asRecord(event.payload);
  const result = asRecord(payload?.result);
  if (!payload || !result) {
    return event;
  }
  const redactedResult = Object.fromEntries(
    Object.entries(result).filter(([key]) => !isRawCoreviewFrameKey(key)),
  );
  return {
    ...event,
    payload: {
      ...payload,
      result: {
        ...redactedResult,
        rawFrameExcluded: true,
      },
    },
  };
}

function isRawCoreviewFrameKey(key: string): boolean {
  return /^(data|base64|frameData|rawFrameData|raw_frame_data|imageData|image_data)$/u.test(key);
}
