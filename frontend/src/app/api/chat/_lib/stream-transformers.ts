import {
  IS_PRODUCTION,
  secureLog,
} from './config';

type StreamMeta = {
  thread_id?: string;
  session_id?: string;
  run_id?: string;
  skill_used?: string;
  emotion_detected?: string;
  pending_interrupt?: object | null;
};

type LeadFilterState = {
  resolved: boolean;
  buffer: string;
};

type TokenOutputState = {
  hasEmittedText: boolean;
  stopped: boolean;
};

interface SSEResponseComplete {
  response: string;
  emotion?: string;
  skill_used?: string;
  response_time_ms?: number;
}

interface SSEArtifactsComplete {
  artifacts?: {
    takeaway?: string;
    reflection_candidate?: { prompt?: string; why?: string };
    memory_candidates?: Array<{ content: string; tags?: string[] }>;
  };
  signals?: object;
  thread_id?: string;
  pending_interrupt?: object | null;
}

interface SSEToken {
  token: string;
  position: number;
}

const LEAK_LEAD_LABELS = [
  'USER MESSAGE:',
  'SYSTEM:',
  'INPUT:',
  'PROMPT:',
  'CONTEXT:',
  'ASSISTANT:',
] as const;

function createStreamId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function encodeSseData(encoder: TextEncoder, payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function encodeSseDone(encoder: TextEncoder): Uint8Array {
  return encoder.encode('data: [DONE]\n\n');
}

function canonicalizeLeadLabel(value: string): string {
  return value
    .toUpperCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trimStart();
}

function stripLeakedLeadTokenChunk(state: LeadFilterState, chunk: string): string {
  if (state.resolved || !chunk) {
    return chunk;
  }

  let working = `${state.buffer}${chunk}`;
  state.buffer = '';

  let stripped = true;
  while (stripped) {
    stripped = false;
    const match = working.match(/^\s*(?:USER(?:\s*_?\s*MESSAGE)?|SYSTEM|INPUT|PROMPT|CONTEXT|ASSISTANT)\s*:\s*/i);
    if (match) {
      working = working.slice(match[0].length);
      stripped = true;
    }
  }

  const trimmedStart = working.trimStart();
  if (!trimmedStart) {
    state.buffer = '';
    return '';
  }

  const canonical = canonicalizeLeadLabel(trimmedStart);
  const isPotentialPartialLead =
    canonical.length <= 24 &&
    LEAK_LEAD_LABELS.some((label) => label.startsWith(canonical));

  if (isPotentialPartialLead) {
    state.buffer = working;
    return '';
  }

  state.resolved = true;
  return working;
}

function stripArtifactsDelimiter(text: string): string {
  if (!text) return text;
  let stripped = text;
  if (text.includes('---ARTIFACTS---')) {
    stripped = text.split('---ARTIFACTS---')[0].trimEnd();
  }
  if (stripped.includes('\n\n---')) {
    stripped = stripped.split('\n\n---')[0].trimEnd();
  }

  const leakageMatch = stripped.match(/(?:^|\n)\s*(?:USER(?:\s*_?\s*MESSAGE)?|SYSTEM|INPUT|PROMPT|CONTEXT|ASSISTANT)\s*:\s*[\s\S]*$/);
  if (leakageMatch && typeof leakageMatch.index === 'number') {
    stripped = stripped.slice(0, leakageMatch.index).trimEnd();
  }

  const placeholderMatch = stripped.match(/(?:^|\n)\s*\[Natural response above\]\s*$/i);
  if (placeholderMatch && typeof placeholderMatch.index === 'number') {
    stripped = stripped.slice(0, placeholderMatch.index).trimEnd();
  }

  return stripped;
}

function findLeakageLabelIndex(text: string): number {
  const leakageMatch = text.match(/(?:^|\n)\s*(?:USER(?:\s*_?\s*MESSAGE)?|SYSTEM|INPUT|PROMPT|CONTEXT|ASSISTANT)\s*:/i);
  const placeholderMatch = text.match(/(?:^|\n)\s*\[Natural response above\]\s*(?=\n|$)/i);
  const leakageIndex = leakageMatch && typeof leakageMatch.index === 'number' ? leakageMatch.index : -1;
  const placeholderIndex = placeholderMatch && typeof placeholderMatch.index === 'number' ? placeholderMatch.index : -1;

  if (leakageIndex >= 0 && placeholderIndex >= 0) {
    return Math.min(leakageIndex, placeholderIndex);
  }

  return leakageIndex >= 0 ? leakageIndex : placeholderIndex;
}

function sanitizeTokenChunkForOutput(
  rawToken: string,
  leadState: LeadFilterState,
  outputState: TokenOutputState,
): string {
  if (outputState.stopped) {
    return '';
  }

  let cleaned = stripLeakedLeadTokenChunk(leadState, rawToken);
  if (!cleaned) {
    return '';
  }

  if (!outputState.hasEmittedText) {
    cleaned = cleaned.replace(/^\s+/, '');
    if (!cleaned) {
      return '';
    }
  }

  const leakageIndex = findLeakageLabelIndex(cleaned);
  if (leakageIndex >= 0) {
    const beforeLeak = cleaned.slice(0, leakageIndex).trimEnd();
    outputState.stopped = true;
    if (beforeLeak) {
      outputState.hasEmittedText = true;
      return beforeLeak;
    }
    return '';
  }

  outputState.hasEmittedText = true;
  return cleaned;
}


export function normalizeArtifactsV1(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;

  const takeaway = typeof payload.takeaway === 'string' ? payload.takeaway : undefined;

  let reflectionCandidate: string | undefined;
  if (typeof payload.reflection_candidate === 'string') {
    reflectionCandidate = payload.reflection_candidate;
  } else if (payload.reflection_candidate && typeof payload.reflection_candidate === 'object') {
    const rc = payload.reflection_candidate as Record<string, unknown>;
    if (typeof rc.prompt === 'string') reflectionCandidate = rc.prompt;
  }

  const memoryCandidatesRaw = Array.isArray(payload.memory_candidates)
    ? payload.memory_candidates
    : [];

  const memory_candidates = memoryCandidatesRaw
    .map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const record = candidate as Record<string, unknown>;
      const text = record.text || record.memory || record.content;
      if (typeof text !== 'string' || text.trim().length === 0) return null;
      return {
        id: String(record.id || record.candidate_id || `mem_${index}`),
        text: String(text),
        category: typeof record.category === 'string' ? record.category : undefined,
        confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
        reason: typeof record.reason === 'string' ? record.reason : undefined,
      };
    })
    .filter((candidate) => candidate !== null)
    .slice(0, 3);

  return {
    artifacts_status: 'complete',
    ...(takeaway ? { takeaway } : {}),
    ...(reflectionCandidate ? { reflection_candidate: reflectionCandidate } : {}),
    ...(memory_candidates.length > 0 ? { memory_candidates } : {}),
  };
}

export function createUIMessageStreamFromText(
  text: string,
  meta?: StreamMeta,
  artifacts?: Record<string, unknown> | null
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const messageId = createStreamId('msg');
  const textId = messageId;
  let started = false;

  return new ReadableStream({
    async start(controller) {
      const emit = (payload: unknown) => controller.enqueue(encodeSseData(encoder, payload));

      const ensureStart = () => {
        if (!started) {
          started = true;
          emit({ type: 'start', messageId });
          emit({ type: 'text-start', id: textId });
        }
      };

      ensureStart();
      const cleanText = stripArtifactsDelimiter(text);
      if (cleanText) {
        emit({ type: 'text-delta', id: textId, delta: cleanText });
      }
      emit({ type: 'text-end', id: textId });

      if (artifacts) {
        emit({ type: 'data-artifactsV1', data: artifacts });
      }

      if (meta && Object.keys(meta).length > 0) {
        emit({ type: 'data-sophia_meta', data: meta });
        if (meta.pending_interrupt) {
          emit({ type: 'data-interrupt', data: meta.pending_interrupt });
        }
      }

      emit({ type: 'finish' });
      controller.enqueue(encodeSseDone(encoder));
      controller.close();
    },
  });
}

/**
 * Transform backend SSE stream to AI SDK data stream protocol.
 */
export function createSSEToUIMessageStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const messageId = createStreamId('msg');
  const textId = messageId;

  let buffer = '';
  let tokenCount = 0;
  let started = false;
  let textEnded = false;
  let isClosed = false;
  let stopTextStreaming = false;
  const leadFilterState: LeadFilterState = { resolved: false, buffer: '' };
  const tokenOutputState: TokenOutputState = { hasEmittedText: false, stopped: false };

  const meta: StreamMeta = {};

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();

      const emit = (payload: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encodeSseData(encoder, payload));
        } catch {
          isClosed = true;
        }
      };

      const ensureStart = () => {
        if (!started) {
          started = true;
          emit({ type: 'start', messageId });
          emit({ type: 'text-start', id: textId });
        }
      };

      const ensureTextEnd = () => {
        if (!started || textEnded) {
          return;
        }
        if (!textEnded) {
          textEnded = true;
          emit({ type: 'text-end', id: textId });
        }
      };

      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          try {
            controller.enqueue(encodeSseDone(encoder));
            controller.close();
          } catch {
            // ignore
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            ensureTextEnd();

            if (meta && Object.keys(meta).length > 0) {
              emit({ type: 'data-sophia_meta', data: meta });
              if (meta.pending_interrupt) {
                emit({ type: 'data-interrupt', data: meta.pending_interrupt });
              }
            }

            emit({ type: 'finish' });
            safeClose();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const eventBlock of events) {
            if (!eventBlock.trim()) continue;

            const lines = eventBlock.split('\n');
            let eventType = '';
            const eventDataLines: string[] = [];

            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                eventDataLines.push(line.slice(5).trim());
              }
            }

            const eventData = eventDataLines.join('\n').trim();

            if (!eventData) continue;

            let cleanData = eventData;
            try {
              if (eventData.startsWith('token ')) {
                cleanData = eventData.slice(6);
              }

              const data = JSON.parse(cleanData);
              const inferredEventType =
                !eventType && data && typeof data === 'object'
                  ? String((data as Record<string, unknown>).event || (data as Record<string, unknown>).type || '')
                  : '';
              const normalizedEventType = eventType || inferredEventType;
              if (!normalizedEventType) continue;

              switch (normalizedEventType) {
                case 'session_start':
                case 'agent_thinking':
                  break;
                case 'error': {
                  const errorMessage =
                    data && typeof data === 'object'
                      ? String((data as Record<string, unknown>).error || '')
                      : '';
                  if (!IS_PRODUCTION) {
                    secureLog('[/api/chat] backend_stream_error_event', {
                      error: errorMessage,
                    });
                  }
                  if (tokenCount === 0) {
                    ensureStart();
                    emit({ type: 'text-delta', id: textId, delta: "I'm having trouble right now. Please try again in a moment." });
                    tokenCount++;
                  }
                  break;
                }
                case 'token': {
                  const tokenData = data as SSEToken;
                  tokenCount++;
                  if (stopTextStreaming) break;
                  const tokenTextRaw = String(tokenData.token ?? '');
                  const tokenText = sanitizeTokenChunkForOutput(
                    tokenTextRaw,
                    leadFilterState,
                    tokenOutputState,
                  );
                  if (!tokenText) {
                    break;
                  }
                  const cutoffIndex = tokenText.indexOf('---');
                  if (cutoffIndex >= 0) {
                    const before = tokenText.slice(0, cutoffIndex);
                    if (before) {
                      ensureStart();
                      emit({ type: 'text-delta', id: textId, delta: before });
                    }
                    stopTextStreaming = true;
                    break;
                  }
                  ensureStart();
                  emit({ type: 'text-delta', id: textId, delta: tokenText });
                  break;
                }
                case 'response_complete': {
                  const resp = data as SSEResponseComplete & {
                    pending_interrupt?: object | null;
                    pendingInterrupt?: object | null;
                    thread_id?: string;
                    threadId?: string;
                  };

                  if (resp.skill_used) meta.skill_used = resp.skill_used;
                  if (resp.emotion) meta.emotion_detected = resp.emotion;

                  const responseThreadId = resp.thread_id || resp.threadId;
                  if (responseThreadId) meta.thread_id = responseThreadId;

                  const responsePendingInterrupt = resp.pending_interrupt ?? resp.pendingInterrupt;
                  if (responsePendingInterrupt !== undefined) {
                    meta.pending_interrupt = responsePendingInterrupt || null;
                  }

                  if (tokenCount === 0 && resp.response) {
                    const cleanText = stripArtifactsDelimiter(resp.response);
                    if (cleanText) {
                      ensureStart();
                      emit({ type: 'text-delta', id: textId, delta: cleanText });
                    }
                  }
                  break;
                }
                case 'artifacts_complete': {
                  const artifactsData = data as SSEArtifactsComplete & {
                    pendingInterrupt?: object | null;
                    threadId?: string;
                  };
                  const artifactsPendingInterrupt = artifactsData.pending_interrupt ?? artifactsData.pendingInterrupt;
                  if (artifactsPendingInterrupt !== undefined) {
                    meta.pending_interrupt = artifactsPendingInterrupt || null;
                  }

                  const extractedArtifacts = artifactsData.artifacts || (artifactsData as Record<string, unknown>).ritual_artifacts;
                  const normalizedArtifacts = normalizeArtifactsV1(extractedArtifacts);
                  if (normalizedArtifacts) {
                    emit({ type: 'data-artifactsV1', data: normalizedArtifacts });
                  }
                  break;
                }
                case 'done':
                  break;
                default:
                  break;
              }
            } catch {
              const fallbackEventType = eventType;
              if (fallbackEventType === 'token') {
                if (!stopTextStreaming) {
                  const cleanedToken = sanitizeTokenChunkForOutput(
                    cleanData,
                    leadFilterState,
                    tokenOutputState,
                  );
                  if (!cleanedToken) {
                    tokenCount++;
                    continue;
                  }
                  ensureStart();
                  emit({ type: 'text-delta', id: textId, delta: cleanedToken });
                  tokenCount++;
                }
                continue;
              }

              if (fallbackEventType === 'response_complete' && tokenCount === 0) {
                const fallbackText = stripArtifactsDelimiter(cleanData);
                if (fallbackText) {
                  ensureStart();
                  emit({ type: 'text-delta', id: textId, delta: fallbackText });
                }
                continue;
              }

              if (fallbackEventType === 'error' && tokenCount === 0) {
                ensureStart();
                emit({ type: 'text-delta', id: textId, delta: "I'm having trouble right now. Please try again in a moment." });
                tokenCount++;
              }
            }
          }
        }
      } catch {
        ensureTextEnd();
        emit({ type: 'finish' });
        safeClose();
      } finally {
        reader.releaseLock();
      }
    },
  });
}
