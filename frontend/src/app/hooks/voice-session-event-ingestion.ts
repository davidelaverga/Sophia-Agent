type AssistantTranscriptHandlers = {
  setFinalReply: (text: string) => void;
  setPartialReply: (text: string) => void;
  addVoiceMessage: (text: string) => void;
  onAssistantResponse?: (text: string) => void;
};

export type AssistantTranscriptUpdate = {
  text: string;
  isFinal: boolean;
  sourceSequence?: number | null;
  responseId?: string | null;
  segmentId?: string | null;
  providerReceivedAt?: string | null;
  assistantTranscriptSource?: string | null;
  assistantTranscriptApproximate?: boolean | null;
};

export type AssistantTranscriptStaleGuardState = {
  highestSourceSequenceByKey: Map<string, number>;
  interruptedKeys: Set<string>;
  activeKey: string | null;
  latestUserInputStartedAtMs: number | null;
};

export type AssistantTranscriptPacingState = {
  lastPartialText: string;
  lastPartialAtMs: number;
};

export type AssistantTranscriptPacingOptions = {
  nowMs?: number;
  minInitialCharacters?: number;
  minCharacterDelta?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
};

const DEFAULT_INITIAL_PARTIAL_CHARACTERS = 24;
const DEFAULT_PARTIAL_CHARACTER_DELTA = 28;
const DEFAULT_PARTIAL_MIN_INTERVAL_MS = 260;
const DEFAULT_PARTIAL_MAX_INTERVAL_MS = 900;

export function parseAssistantTranscriptUpdate(data: Record<string, unknown> | undefined): AssistantTranscriptUpdate | null {
  const text = typeof data?.text === 'string' ? data.text : '';
  if (!text) return null;

  return {
    text,
    isFinal: data?.is_final === true || data?.final === true,
    sourceSequence: readPositiveInteger(data?.source_sequence ?? data?.sourceSequence),
    responseId: readOptionalString(data?.response_id ?? data?.responseId),
    segmentId: readOptionalString(data?.segment_id ?? data?.segmentId),
    providerReceivedAt: readOptionalString(data?.provider_received_at ?? data?.providerReceivedAt),
    assistantTranscriptSource: readOptionalString(
      data?.assistant_transcript_source
      ?? data?.assistantTranscriptSource
      ?? data?.source,
    ),
    assistantTranscriptApproximate: readOptionalBoolean(
      data?.assistant_transcript_approximate
      ?? data?.assistantTranscriptApproximate,
    ),
  };
}

export function createAssistantTranscriptStaleGuardState(): AssistantTranscriptStaleGuardState {
  return {
    highestSourceSequenceByKey: new Map(),
    interruptedKeys: new Set(),
    activeKey: null,
    latestUserInputStartedAtMs: null,
  };
}

export function resetAssistantTranscriptStaleGuardState(state: AssistantTranscriptStaleGuardState): void {
  state.highestSourceSequenceByKey.clear();
  state.interruptedKeys.clear();
  state.activeKey = null;
  state.latestUserInputStartedAtMs = null;
}

export function markActiveAssistantTranscriptInterrupted(
  state: AssistantTranscriptStaleGuardState,
  options: { atMs?: number | null } = {},
): string[] {
  const interruptedKeys: string[] = [];
  if (state.activeKey) {
    state.interruptedKeys.add(state.activeKey);
    interruptedKeys.push(state.activeKey);
  }
  if (typeof options.atMs === 'number' && Number.isFinite(options.atMs)) {
    state.latestUserInputStartedAtMs = Math.max(state.latestUserInputStartedAtMs ?? 0, options.atMs);
  }
  return interruptedKeys;
}

export function markAssistantTranscriptUserInputStarted(
  state: AssistantTranscriptStaleGuardState,
  atMs = Date.now(),
): string[] {
  return markActiveAssistantTranscriptInterrupted(state, { atMs });
}

export function markAssistantTranscriptGenerationStarted(state: AssistantTranscriptStaleGuardState): void {
  state.activeKey = null;
  state.interruptedKeys.delete('active:default');
}

export function shouldApplyAssistantTranscriptUpdate(
  update: AssistantTranscriptUpdate,
  state: AssistantTranscriptStaleGuardState,
): boolean {
  const key = assistantTranscriptStaleGuardKey(update);
  const providerReceivedAtMs = parseTimestampMs(update.providerReceivedAt);
  if (
    providerReceivedAtMs !== null
    && state.latestUserInputStartedAtMs !== null
    && providerReceivedAtMs <= state.latestUserInputStartedAtMs
  ) {
    return false;
  }

  if (state.interruptedKeys.has(key)) {
    return false;
  }

  if (update.sourceSequence == null) {
    state.activeKey = key;
    return true;
  }
  const highest = state.highestSourceSequenceByKey.get(key);
  if (highest !== undefined && update.sourceSequence <= highest) {
    return false;
  }
  state.highestSourceSequenceByKey.set(key, update.sourceSequence);
  state.activeKey = key;
  return true;
}

export function applyAssistantTranscriptUpdate(
  update: AssistantTranscriptUpdate,
  handlers: AssistantTranscriptHandlers,
): void {
  if (update.isFinal) {
    handlers.setFinalReply(update.text);
    handlers.setPartialReply('');
    handlers.addVoiceMessage(update.text);
    handlers.onAssistantResponse?.(update.text);
    return;
  }

  handlers.setPartialReply(update.text);
}

export function createAssistantTranscriptPacingState(): AssistantTranscriptPacingState {
  return {
    lastPartialText: '',
    lastPartialAtMs: 0,
  };
}

export function resetAssistantTranscriptPacingState(state: AssistantTranscriptPacingState): void {
  state.lastPartialText = '';
  state.lastPartialAtMs = 0;
}

export function shouldEmitPacedAssistantPartial(
  text: string,
  state: AssistantTranscriptPacingState,
  options: AssistantTranscriptPacingOptions = {},
): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed === state.lastPartialText) {
    return false;
  }

  const nowMs = options.nowMs ?? Date.now();
  const minInitialCharacters = options.minInitialCharacters ?? DEFAULT_INITIAL_PARTIAL_CHARACTERS;
  const minCharacterDelta = options.minCharacterDelta ?? DEFAULT_PARTIAL_CHARACTER_DELTA;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_PARTIAL_MIN_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_PARTIAL_MAX_INTERVAL_MS;
  const elapsedMs = state.lastPartialAtMs > 0 ? nowMs - state.lastPartialAtMs : Number.POSITIVE_INFINITY;
  const characterDelta = Math.abs(trimmed.length - state.lastPartialText.length);
  const endedAtNaturalBoundary = /[.!?;:]$/.test(trimmed) || /[,)]$/.test(trimmed);

  if (!state.lastPartialText) {
    return trimmed.length >= minInitialCharacters || endedAtNaturalBoundary;
  }

  if (!trimmed.startsWith(state.lastPartialText) && elapsedMs >= minIntervalMs) {
    return true;
  }

  if (endedAtNaturalBoundary && elapsedMs >= minIntervalMs && characterDelta >= 8) {
    return true;
  }

  if (elapsedMs >= maxIntervalMs && characterDelta >= 12) {
    return true;
  }

  return elapsedMs >= minIntervalMs && characterDelta >= minCharacterDelta;
}

export function applyPacedAssistantTranscriptUpdate(
  update: AssistantTranscriptUpdate,
  handlers: AssistantTranscriptHandlers,
  state: AssistantTranscriptPacingState,
  options: AssistantTranscriptPacingOptions = {},
): boolean {
  if (update.isFinal) {
    applyAssistantTranscriptUpdate(update, handlers);
    resetAssistantTranscriptPacingState(state);
    return true;
  }

  if (!shouldEmitPacedAssistantPartial(update.text, state, options)) {
    return false;
  }

  const emittedText = update.text.trim();
  handlers.setPartialReply(emittedText);
  state.lastPartialText = emittedText;
  state.lastPartialAtMs = options.nowMs ?? Date.now();
  return true;
}

function assistantTranscriptStaleGuardKey(update: AssistantTranscriptUpdate): string {
  return `${update.responseId ?? 'active'}:${update.segmentId ?? 'default'}`;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function readOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
