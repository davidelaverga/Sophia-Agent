export type VoiceBenchmarkAutoClassification =
  | 'completed'
  | 'harness_input_missing'
  | 'no_turn_closure'
  | 'wrong_emitted_artifact';

export type VoiceBenchmarkHarnessInputReason =
  | 'browser_audio_detected'
  | 'microphone_stream_without_audio'
  | 'no_microphone_stream'
  | 'turn_events_observed';

export type VoiceBenchmarkTurnCloseMetricSource =
  | 'committed_user_transcript'
  | 'public_turn_event';

export interface VoiceBenchmarkExpectation {
  emotionFamilies?: string[];
  responseIntent?: string | null;
  spokenDelivery?: string | null;
  toneBand?: string | null;
}

export interface VoiceBenchmarkCaseDefinition {
  id: string;
  label: string;
  category: string;
  audioFile: string;
  automation?: string;
  awaitArtifactMs?: number;
  expected?: VoiceBenchmarkExpectation;
  profileDir?: string;
  ritual?: string;
  route?: string;
  settleMs?: number;
}

export interface VoiceBenchmarkManifest {
  suite: string;
  version: number;
  defaults?: {
    automation?: string;
    awaitArtifactMs?: number;
    ritual?: string;
    route?: string;
    settleMs?: number;
  };
  cases: VoiceBenchmarkCaseDefinition[];
}

export interface VoiceBenchmarkCaseReport {
  caseId: string;
  label: string;
  category: string;
  capturePath: string | null;
  harness: {
    classification: {
      inputReceived: boolean;
      reason: VoiceBenchmarkHarnessInputReason | null;
    };
    configured: {
      channelCount: number | null;
      durationMs: number | null;
      fakeAudioFile: string | null;
      sampleRate: number | null;
      sizeBytes: number | null;
    };
    observed: {
      audioDetected: boolean;
      audioTrackCount: number;
      errors: string[];
      firstAudioAt: string | null;
      firstStreamAt: string | null;
      lastAudioAt: string | null;
      maxAbsPeak: number | null;
      maxRms: number | null;
      microphoneStreamAcquired: boolean;
      nonSilentSampleWindows: number;
      streamCount: number;
      totalSampleWindows: number;
    };
  };
  metrics: {
    artifact_receipt: boolean;
    capture_window_ms_after_first_user_ended: number | null;
    duplicate_phase_counts: Record<string, number>;
    false_user_ended_count: number;
    first_agent_started_at: string | null;
    first_committed_user_transcript_at: string | null;
    first_user_ended_at: string | null;
    join_latency_ms: number | null;
    raw_turn_close_ms: number | null;
    response_completion: boolean;
    terminal_reason: string | null;
    turn_close_ms: number | null;
    turn_close_metric_source: VoiceBenchmarkTurnCloseMetricSource | null;
  };
  actual: {
    emotionFamily: string | null;
    responseText: string | null;
    toneBand: string | null;
    voiceEmotionPrimary: string | null;
    voiceEmotionSecondary: string | null;
    voiceSpeed: string | null;
  };
  expected: {
    emotionFamilies: string[];
    responseIntent: string | null;
    spokenDelivery: string | null;
    toneBand: string | null;
  };
  comparisons: {
    emotionFamilyHit: boolean | null;
    toneBandHit: boolean | null;
  };
  classification: {
    auto: VoiceBenchmarkAutoClassification;
    blockedManualReason: string | null;
  };
  manualReview: {
    responseIntent: {
      expected: string | null;
      observed: string | null;
      required: boolean;
    };
    spokenDelivery: {
      expected: string | null;
      expectedFamilies: string[];
      observedArtifactFamily: string | null;
      observedVoiceSpeed: string | null;
      required: boolean;
    };
  };
}

export interface VoiceBenchmarkSuiteSummary {
  auto_class_counts: Record<VoiceBenchmarkAutoClassification, number>;
  completed_cases: number;
  completion_rate: number;
  emotion_family_hit_rate: number | null;
  harness_input_detected_cases: number;
  harness_input_missing_cases: number;
  max_join_latency_ms: number | null;
  mean_join_latency_ms: number | null;
  median_false_user_ended_count: number | null;
  median_join_latency_ms: number | null;
  median_raw_turn_close_ms: number | null;
  median_turn_close_ms: number | null;
  min_join_latency_ms: number | null;
  suite: string;
  tone_band_hit_rate: number | null;
  total_cases: number;
  version: number;
}

type CaptureEvent = {
  category?: unknown;
  name?: unknown;
  payload?: unknown;
  recordedAt?: unknown;
};

type CapturePayload = {
  harness?: unknown;
  captureBundle?: {
    events?: CaptureEvent[];
    exportedAt?: unknown;
    snapshot?: unknown;
    startedAt?: unknown;
  };
  domSummary?: unknown;
};

const EMOTION_FAMILY_MAP: Record<string, readonly string[]> = {
  celebratory: [
    'amazed',
    'elated',
    'enthusiastic',
    'euphoric',
    'excited',
    'happy',
    'proud',
    'triumphant',
  ],
  challenging: ['confident', 'determined'],
  distressed: [
    'alarmed',
    'anxious',
    'confused',
    'dejected',
    'disappointed',
    'guilty',
    'hesitant',
    'hurt',
    'insecure',
    'melancholic',
    'panicked',
    'rejected',
    'resigned',
    'sad',
    'scared',
    'tired',
  ],
  guarded: ['contempt', 'distant', 'envious', 'ironic', 'sarcastic', 'skeptical'],
  reflective: ['anticipation', 'contemplative', 'curious', 'mysterious', 'nostalgic', 'wistful'],
  supportive: ['affectionate', 'calm', 'content', 'grateful', 'neutral', 'peaceful', 'serene', 'sympathetic', 'trust'],
  urgent: ['agitated', 'angry', 'frustrated', 'mad', 'outraged', 'threatened'],
};

const TURN_COMPLETED_REASON = 'completed';

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function compactNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

function findLast<T>(values: T[], predicate: (value: T) => boolean): T | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return values[index];
    }
  }
  return null;
}

function getCaptureEvents(payload: CapturePayload): CaptureEvent[] {
  return asArray(payload.captureBundle?.events) as CaptureEvent[];
}

function getCaptureExportedAt(payload: CapturePayload): string | null {
  return asString(payload.captureBundle?.exportedAt);
}

function getEventData(event: CaptureEvent): Record<string, unknown> | null {
  return asRecord(asRecord(event.payload)?.data ?? null);
}

function getEventName(event: CaptureEvent): string | null {
  return asString(event.name);
}

function getEventPhase(event: CaptureEvent): string | null {
  return asString(getEventData(event)?.phase);
}

function getLatestArtifact(payload: CapturePayload): Record<string, unknown> | null {
  const events = getCaptureEvents(payload);
  const artifactEvent = findLast(
    events,
    (event) => event.category === 'stream-custom' && getEventName(event) === 'sophia.artifact'
  );

  const snapshotArtifact = getNestedRecord(payload, [
    'captureBundle',
    'snapshot',
    'artifacts',
    'sessionArtifacts',
  ]);

  const eventArtifact = artifactEvent ? getEventData(artifactEvent) : null;

  if (snapshotArtifact && eventArtifact) {
    return {
      ...snapshotArtifact,
      ...eventArtifact,
    };
  }

  return eventArtifact ?? snapshotArtifact;
}

function getLatestTurnDiagnostic(payload: CapturePayload): Record<string, unknown> | null {
  const events = getCaptureEvents(payload);
  const diagnosticEvent = findLast(
    events,
    (event) => event.category === 'stream-custom' && getEventName(event) === 'sophia.turn_diagnostic'
  );

  return diagnosticEvent ? getEventData(diagnosticEvent) : null;
}

function getConfiguredFakeAudio(payload: CapturePayload): Record<string, unknown> | null {
  return getNestedRecord(payload, ['harness', 'fakeAudioFile']);
}

function getObservedMicrophone(payload: CapturePayload): Record<string, unknown> | null {
  return getNestedRecord(payload, ['captureBundle', 'snapshot', 'harness', 'microphone']);
}

function getNestedRecord(root: unknown, path: string[]): Record<string, unknown> | null {
  let current: unknown = root;

  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return null;
    }
    current = record[key];
  }

  return asRecord(current);
}

function getNestedString(root: unknown, path: string[]): string | null {
  let current: unknown = root;

  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return null;
    }
    current = record[key];
  }

  return asString(current);
}

function hasArtifactReceipt(artifact: Record<string, unknown> | null): boolean {
  if (!artifact) {
    return false;
  }

  return Object.values(artifact).some((value) => {
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value);
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    return value !== null && value !== undefined;
  });
}

function getLatestFinalTranscriptText(payload: CapturePayload): string | null {
  const events = getCaptureEvents(payload);
  const finalTranscript = findLast(events, (event) => {
    if (event.category !== 'stream-custom' || getEventName(event) !== 'sophia.transcript') {
      return false;
    }

    return getEventData(event)?.is_final === true;
  });

  const finalText = finalTranscript ? asString(getEventData(finalTranscript)?.text) : null;
  if (finalText) {
    return finalText;
  }

  const voiceMessages = asArray(
    getNestedRecord(payload, ['captureBundle', 'snapshot', 'transcript'])?.voiceMessages
  );

  const lastVoiceMessage = voiceMessages[voiceMessages.length - 1];
  const voiceMessageText = asString(asRecord(lastVoiceMessage)?.content);
  if (voiceMessageText) {
    return voiceMessageText;
  }

  const transcriptMessages = asArray(asRecord(payload.domSummary)?.transcriptMessages);
  const lastTranscriptMessage = transcriptMessages[transcriptMessages.length - 1];

  return asString(asRecord(lastTranscriptMessage)?.text);
}

function getJoinedAtEvent(events: CaptureEvent[]): CaptureEvent | null {
  return events.find((event) => {
    if (event.category !== 'voice-session' || getEventName(event) !== 'calling-state-changed') {
      return false;
    }

    const payload = asRecord(event.payload);
    const detail = asRecord(payload?.data ?? payload);

    return detail?.callingState === 'joined' || detail?.mappedStage === 'listening';
  }) ?? null;
}

function getIsoAt(event: CaptureEvent | null): string | null {
  return event ? asString(event.recordedAt) : null;
}

function getMsFromIso(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function normalizeEmotionFamily(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.trim().toLowerCase();
}

export function mapEmotionToFamily(label: string | null | undefined): string | null {
  const normalized = normalizeEmotionFamily(label ?? null);
  if (!normalized) {
    return null;
  }

  for (const [family, labels] of Object.entries(EMOTION_FAMILY_MAP)) {
    if (labels.includes(normalized)) {
      return family;
    }
  }

  return null;
}

export function analyzeVoiceBenchmarkCapture({
  capturePath = null,
  capture,
  definition,
}: {
  capturePath?: string | null;
  capture: CapturePayload;
  definition: VoiceBenchmarkCaseDefinition;
}): VoiceBenchmarkCaseReport {
  const events = getCaptureEvents(capture);
  const terminalDiagnostic = getLatestTurnDiagnostic(capture);
  const diagnosticFirstTextMs = asNumber(terminalDiagnostic?.first_text_ms);
  const startRequested =
    events.find(
      (event) => event.category === 'voice-session' && getEventName(event) === 'start-talking-requested'
    ) ?? null;
  const joined = getJoinedAtEvent(events);
  const userEndedEvents = events.filter(
    (event) => event.category === 'stream-custom' && getEventName(event) === 'sophia.turn' && getEventPhase(event) === 'user_ended'
  );
  const userTranscriptEvents = events.filter(
    (event) => event.category === 'stream-custom' && getEventName(event) === 'sophia.user_transcript'
  );
  const agentStartedEvents = events.filter(
    (event) => event.category === 'stream-custom' && getEventName(event) === 'sophia.turn' && getEventPhase(event) === 'agent_started'
  );
  const agentEndedEvents = events.filter(
    (event) => event.category === 'stream-custom' && getEventName(event) === 'sophia.turn' && getEventPhase(event) === 'agent_ended'
  );

  const firstUserEndedAt = getIsoAt(userEndedEvents[0] ?? null);
  const firstAgentStartedAt = getIsoAt(agentStartedEvents[0] ?? null);
  const firstAgentStartedMs = getMsFromIso(firstAgentStartedAt);
  const firstCommittedUserTranscriptAt = (() => {
    if (firstAgentStartedMs === null) {
      return null;
    }

    const committedEvent = findLast(userTranscriptEvents, (event) => {
      const recordedAtMs = getMsFromIso(getIsoAt(event));
      return recordedAtMs !== null && recordedAtMs <= firstAgentStartedMs;
    });

    return getIsoAt(committedEvent ?? null);
  })();
  const joinLatencyMs = (() => {
    const startMs = getMsFromIso(getIsoAt(startRequested));
    const joinedMs = getMsFromIso(getIsoAt(joined));
    if (startMs === null || joinedMs === null) {
      return null;
    }

    return Math.max(0, joinedMs - startMs);
  })();
  const publicTurnCloseMs = (() => {
    const firstUserEndedMs = getMsFromIso(firstUserEndedAt);

    if (firstUserEndedMs === null || firstAgentStartedMs === null) {
      return null;
    }

    return Math.max(0, firstAgentStartedMs - firstUserEndedMs);
  })();
  const committedTurnCloseMs = (() => {
    const committedUserTranscriptMs = getMsFromIso(firstCommittedUserTranscriptAt);

    if (committedUserTranscriptMs === null || firstAgentStartedMs === null) {
      return null;
    }

    return Math.max(0, firstAgentStartedMs - committedUserTranscriptMs);
  })();
  const rawTurnCloseMs =
    diagnosticFirstTextMs === null ? null : Math.max(0, diagnosticFirstTextMs);
  const turnCloseMs = committedTurnCloseMs ?? publicTurnCloseMs;
  const turnCloseMetricSource = committedTurnCloseMs !== null
    ? 'committed_user_transcript'
    : publicTurnCloseMs !== null
      ? 'public_turn_event'
      : null;
  const captureWindowMsAfterFirstUserEnded = (() => {
    const firstUserEndedMs = getMsFromIso(firstUserEndedAt);
    const exportedAtMs = getMsFromIso(getCaptureExportedAt(capture));

    if (firstUserEndedMs === null || exportedAtMs === null) {
      return null;
    }

    return Math.max(0, exportedAtMs - firstUserEndedMs);
  })();
  const falseUserEndedCount = userEndedEvents.filter((event) => {
    const recordedAtMs = getMsFromIso(getIsoAt(event));
    if (recordedAtMs === null) {
      return false;
    }

    return firstAgentStartedMs === null ? true : recordedAtMs <= firstAgentStartedMs;
  }).length;

  const phaseCounts: Record<string, number> = {};
  for (const event of [...userEndedEvents, ...agentStartedEvents, ...agentEndedEvents]) {
    const phase = getEventPhase(event);
    if (!phase) {
      continue;
    }
    phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
  }

  const duplicatePhaseCounts = Object.fromEntries(
    Object.entries(phaseCounts)
      .filter(([phase, count]) => phase !== 'user_ended' && count > 1)
      .map(([phase, count]) => [phase, count - 1])
  );

  const artifact = getLatestArtifact(capture);
  const artifactReceipt = hasArtifactReceipt(artifact);
  const responseText = getLatestFinalTranscriptText(capture);
  const responseCompletion = Boolean(firstAgentStartedAt && responseText && artifactReceipt);
  const terminalReason =
    asString(terminalDiagnostic?.reason) ?? (responseCompletion ? TURN_COMPLETED_REASON : null);
  const diagnosticRawFalseEndCount = asNumber(terminalDiagnostic?.raw_false_end_count);
  const diagnosticDuplicatePhaseCounts = asRecord(terminalDiagnostic?.duplicate_phase_counts);
  const resolvedDuplicatePhaseCounts = diagnosticDuplicatePhaseCounts
    ? Object.fromEntries(
        Object.entries(diagnosticDuplicatePhaseCounts).filter(([, count]) => asNumber(count) !== null)
      )
    : duplicatePhaseCounts;
  const expectedFamilies = (definition.expected?.emotionFamilies ?? [])
    .map((family) => normalizeEmotionFamily(family))
    .filter((family): family is string => Boolean(family));
  const actualToneBand = asString(artifact?.active_tone_band ?? null);
  const actualVoiceEmotionPrimary = asString(artifact?.voice_emotion_primary ?? null);
  const actualEmotionFamily = mapEmotionToFamily(actualVoiceEmotionPrimary);
  const configuredFakeAudio = getConfiguredFakeAudio(capture);
  const observedMicrophone = getObservedMicrophone(capture);
  const harnessTelemetryAvailable = observedMicrophone !== null;
  const observedStreamCount = asNumber(observedMicrophone?.streamCount) ?? 0;
  const observedAudioTrackCount = asNumber(observedMicrophone?.audioTrackCount) ?? 0;
  const observedFirstStreamAt = asString(observedMicrophone?.firstStreamAt ?? null);
  const observedFirstAudioAt = asString(observedMicrophone?.firstAudioAt ?? null);
  const observedLastAudioAt = asString(observedMicrophone?.lastAudioAt ?? null);
  const observedAudioDetected = asBoolean(observedMicrophone?.detectedAudio) === true;
  const observedTotalSampleWindows = asNumber(observedMicrophone?.totalSampleWindows) ?? 0;
  const observedNonSilentSampleWindows =
    asNumber(observedMicrophone?.nonSilentSampleWindows) ?? 0;
  const observedMaxRms = asNumber(observedMicrophone?.maxRms);
  const observedMaxAbsPeak = asNumber(observedMicrophone?.maxAbsPeak);
  const observedErrors = asArray(observedMicrophone?.errors)
    .map((value) => asString(value))
    .filter((value): value is string => Boolean(value));
  const microphoneStreamAcquired = observedStreamCount > 0 || observedFirstStreamAt !== null;
  const harnessInputReason: VoiceBenchmarkHarnessInputReason | null = observedAudioDetected
    ? 'browser_audio_detected'
    : firstUserEndedAt !== null
      ? 'turn_events_observed'
      : harnessTelemetryAvailable && microphoneStreamAcquired
        ? 'microphone_stream_without_audio'
        : harnessTelemetryAvailable
          ? 'no_microphone_stream'
          : null;
  const harnessInputReceived =
    observedAudioDetected || harnessInputReason === 'turn_events_observed';
  const toneBandHit =
    responseCompletion && definition.expected?.toneBand
      ? actualToneBand === definition.expected.toneBand
      : null;
  const emotionFamilyHit =
    responseCompletion && expectedFamilies.length > 0
      ? actualEmotionFamily !== null && expectedFamilies.includes(actualEmotionFamily)
      : null;

  let autoClassification: VoiceBenchmarkAutoClassification = 'completed';
  if (
    harnessTelemetryAvailable &&
    !responseCompletion &&
    !harnessInputReceived
  ) {
    autoClassification = 'harness_input_missing';
  } else if (!responseCompletion || (terminalReason !== null && terminalReason !== TURN_COMPLETED_REASON)) {
    autoClassification = 'no_turn_closure';
  } else if (toneBandHit === false || emotionFamilyHit === false) {
    autoClassification = 'wrong_emitted_artifact';
  }

  const blockedManualReason = responseCompletion ? null : autoClassification;

  return {
    caseId: definition.id,
    label: definition.label,
    category: definition.category,
    capturePath,
    harness: {
      classification: {
        inputReceived: harnessInputReceived,
        reason: harnessInputReason,
      },
      configured: {
        channelCount: asNumber(getNestedRecord(configuredFakeAudio, ['wav'])?.channelCount),
        durationMs: asNumber(getNestedRecord(configuredFakeAudio, ['wav'])?.durationMs),
        fakeAudioFile:
          asString(configuredFakeAudio?.basename) ?? asString(configuredFakeAudio?.path),
        sampleRate: asNumber(getNestedRecord(configuredFakeAudio, ['wav'])?.sampleRate),
        sizeBytes: asNumber(configuredFakeAudio?.sizeBytes),
      },
      observed: {
        audioDetected: observedAudioDetected,
        audioTrackCount: observedAudioTrackCount,
        errors: observedErrors,
        firstAudioAt: observedFirstAudioAt,
        firstStreamAt: observedFirstStreamAt,
        lastAudioAt: observedLastAudioAt,
        maxAbsPeak: observedMaxAbsPeak,
        maxRms: observedMaxRms,
        microphoneStreamAcquired,
        nonSilentSampleWindows: observedNonSilentSampleWindows,
        streamCount: observedStreamCount,
        totalSampleWindows: observedTotalSampleWindows,
      },
    },
    metrics: {
      artifact_receipt: artifactReceipt,
      capture_window_ms_after_first_user_ended: captureWindowMsAfterFirstUserEnded,
      duplicate_phase_counts: resolvedDuplicatePhaseCounts,
      false_user_ended_count: diagnosticRawFalseEndCount ?? falseUserEndedCount,
      first_agent_started_at: firstAgentStartedAt,
      first_committed_user_transcript_at: firstCommittedUserTranscriptAt,
      first_user_ended_at: firstUserEndedAt,
      join_latency_ms: joinLatencyMs,
      raw_turn_close_ms: rawTurnCloseMs,
      response_completion: responseCompletion,
      terminal_reason: terminalReason,
      turn_close_ms: turnCloseMs,
      turn_close_metric_source: turnCloseMetricSource,
    },
    actual: {
      emotionFamily: actualEmotionFamily,
      responseText,
      toneBand: actualToneBand,
      voiceEmotionPrimary: actualVoiceEmotionPrimary,
      voiceEmotionSecondary: asString(artifact?.voice_emotion_secondary ?? null),
      voiceSpeed: asString(artifact?.voice_speed ?? null),
    },
    expected: {
      emotionFamilies: expectedFamilies,
      responseIntent: definition.expected?.responseIntent ?? null,
      spokenDelivery: definition.expected?.spokenDelivery ?? null,
      toneBand: definition.expected?.toneBand ?? null,
    },
    comparisons: {
      emotionFamilyHit,
      toneBandHit,
    },
    classification: {
      auto: autoClassification,
      blockedManualReason,
    },
    manualReview: {
      responseIntent: {
        expected: definition.expected?.responseIntent ?? null,
        observed: responseText,
        required: responseCompletion,
      },
      spokenDelivery: {
        expected: definition.expected?.spokenDelivery ?? null,
        expectedFamilies,
        observedArtifactFamily: actualEmotionFamily,
        observedVoiceSpeed: asString(artifact?.voice_speed ?? null),
        required: responseCompletion,
      },
    },
  };
}

export function summarizeVoiceBenchmarkReports({
  manifest,
  reports,
}: {
  manifest: VoiceBenchmarkManifest;
  reports: VoiceBenchmarkCaseReport[];
}): VoiceBenchmarkSuiteSummary {
  const completedReports = reports.filter((report) => report.metrics.response_completion);
  const joinLatencies = compactNumbers(reports.map((report) => report.metrics.join_latency_ms));
  const turnCloseValues = compactNumbers(
    completedReports.map((report) => report.metrics.turn_close_ms)
  );
  const rawTurnCloseValues = compactNumbers(
    completedReports.map((report) => report.metrics.raw_turn_close_ms)
  );
  const falseUserEndedCounts = reports.map((report) => report.metrics.false_user_ended_count);
  const emotionComparisons = completedReports
    .map((report) => report.comparisons.emotionFamilyHit)
    .filter((value): value is boolean => value !== null);
  const toneBandComparisons = completedReports
    .map((report) => report.comparisons.toneBandHit)
    .filter((value): value is boolean => value !== null);
  const autoClassCounts: Record<VoiceBenchmarkAutoClassification, number> = {
    completed: 0,
    harness_input_missing: 0,
    no_turn_closure: 0,
    wrong_emitted_artifact: 0,
  };

  for (const report of reports) {
    autoClassCounts[report.classification.auto] += 1;
  }

  return {
    auto_class_counts: autoClassCounts,
    completed_cases: completedReports.length,
    completion_rate: reports.length === 0 ? 0 : Number((completedReports.length / reports.length).toFixed(2)),
    emotion_family_hit_rate:
      emotionComparisons.length === 0
        ? null
        : Number(
            (
              emotionComparisons.filter((value) => value).length / emotionComparisons.length
            ).toFixed(2)
          ),
    harness_input_detected_cases: reports.filter(
      (report) => report.harness.classification.inputReceived
    ).length,
    harness_input_missing_cases: autoClassCounts.harness_input_missing,
    max_join_latency_ms: joinLatencies.length === 0 ? null : Math.max(...joinLatencies),
    mean_join_latency_ms: mean(joinLatencies),
    median_false_user_ended_count: median(falseUserEndedCounts),
    median_join_latency_ms: median(joinLatencies),
    median_raw_turn_close_ms: median(rawTurnCloseValues),
    median_turn_close_ms: median(turnCloseValues),
    min_join_latency_ms: joinLatencies.length === 0 ? null : Math.min(...joinLatencies),
    suite: manifest.suite,
    tone_band_hit_rate:
      toneBandComparisons.length === 0
        ? null
        : Number(
            (
              toneBandComparisons.filter((value) => value).length / toneBandComparisons.length
            ).toFixed(2)
          ),
    total_cases: reports.length,
    version: manifest.version,
  };
}