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
};

export type AssistantTranscriptStaleGuardState = {
  highestSourceSequenceByKey: Map<string, number>;
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
  };
}

export function createAssistantTranscriptStaleGuardState(): AssistantTranscriptStaleGuardState {
  return {
    highestSourceSequenceByKey: new Map(),
  };
}

export function resetAssistantTranscriptStaleGuardState(state: AssistantTranscriptStaleGuardState): void {
  state.highestSourceSequenceByKey.clear();
}

export function shouldApplyAssistantTranscriptUpdate(
  update: AssistantTranscriptUpdate,
  state: AssistantTranscriptStaleGuardState,
): boolean {
  if (update.sourceSequence == null) {
    return true;
  }
  const key = assistantTranscriptStaleGuardKey(update);
  const highest = state.highestSourceSequenceByKey.get(key);
  if (highest !== undefined && update.sourceSequence <= highest) {
    return false;
  }
  state.highestSourceSequenceByKey.set(key, update.sourceSequence);
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
  handlers.onAssistantResponse?.(update.text);
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
  handlers.onAssistantResponse?.(emittedText);
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
