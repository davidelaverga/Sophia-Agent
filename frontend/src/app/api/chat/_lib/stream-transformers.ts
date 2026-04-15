import { normalizeBuilderArtifactPayload } from '../../../lib/builder-artifacts';
import type { BuilderTaskV1 } from '../../../types/builder-task';

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

type LangGraphToolAccumulator = {
  name: string;
  jsonParts: string[];
};

type BuilderTaskAccumulator = {
  label?: string;
};

type BuilderTodoRecord = NonNullable<BuilderTaskV1['todos']>[number];

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
  } else if (typeof payload.reflection === 'string') {
    reflectionCandidate = payload.reflection;
  } else if (payload.reflection_candidate && typeof payload.reflection_candidate === 'object') {
    const rc = payload.reflection_candidate as Record<string, unknown>;
    if (typeof rc.prompt === 'string') reflectionCandidate = rc.prompt;
  } else if (payload.reflection && typeof payload.reflection === 'object') {
    const reflection = payload.reflection as Record<string, unknown>;
    if (typeof reflection.prompt === 'string') reflectionCandidate = reflection.prompt;
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

function extractRunId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;

  const record = metadata as Record<string, unknown>;
  const runId = record.run_id || record.runId || record.langgraph_run_id;
  return typeof runId === 'string' ? runId : undefined;
}

function parseAccumulatedArtifact(toolCalls: Record<string, LangGraphToolAccumulator>): Record<string, unknown> | null {
  for (const toolCall of Object.values(toolCalls)) {
    if (toolCall.name !== 'emit_artifact') continue;
    const raw = toolCall.jsonParts.join('');
    if (!raw.trim()) continue;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function parseAccumulatedBuilderArtifact(toolCalls: Record<string, LangGraphToolAccumulator>) {
  for (const toolCall of Object.values(toolCalls)) {
    if (toolCall.name !== 'emit_builder_artifact') continue;
    const raw = toolCall.jsonParts.join('');
    if (!raw.trim()) continue;

    try {
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }

  return null;
}

function extractToolCallArtifact(toolCalls: unknown): Record<string, unknown> | null {
  if (!Array.isArray(toolCalls)) return null;

  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== 'object') continue;
    const record = toolCall as Record<string, unknown>;
    if (record.name !== 'emit_artifact') continue;
    if (record.args && typeof record.args === 'object') {
      return record.args as Record<string, unknown>;
    }
  }

  return null;
}

function extractToolCallBuilderArtifact(toolCalls: unknown) {
  if (!Array.isArray(toolCalls)) return null;

  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== 'object') continue;
    const record = toolCall as Record<string, unknown>;
    if (record.name !== 'emit_builder_artifact') continue;
    return record.args;
  }

  return null;
}

function extractValuesArtifact(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;

  const record = data as Record<string, unknown>;
  if (record.current_artifact && typeof record.current_artifact === 'object') {
    return record.current_artifact as Record<string, unknown>;
  }

  const values = record.values;
  if (!values || typeof values !== 'object') return null;

  const artifact = (values as Record<string, unknown>).current_artifact;
  if (artifact && typeof artifact === 'object') {
    return artifact as Record<string, unknown>;
  }

  return null;
}

function extractValuesBuilderArtifact(data: unknown) {
  if (!data || typeof data !== 'object') return null;

  const record = data as Record<string, unknown>;
  if (record.builder_result !== undefined) {
    return record.builder_result;
  }

  const values = record.values;
  if (!values || typeof values !== 'object') return null;

  return (values as Record<string, unknown>).builder_result ?? null;
}

function isBuilderTaskDescription(description: string | undefined): boolean {
  if (!description) return false;
  return description.trim().toLowerCase().includes('builder');
}

function extractTaskMessageText(message: unknown): string | undefined {
  if (typeof message === 'string') {
    const cleaned = stripArtifactsDelimiter(message).trim();
    return cleaned || undefined;
  }

  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const record = message as Record<string, unknown>;
  const content = record.content;

  if (typeof content === 'string') {
    const cleaned = stripArtifactsDelimiter(content).trim();
    return cleaned || undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as Record<string, unknown>;
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return undefined;

  const cleaned = stripArtifactsDelimiter(text).trim();
  return cleaned || undefined;
}

function buildRunningTaskDetail(data: Record<string, unknown>): string | undefined {
  const stuckReason = typeof data.stuck_reason === 'string'
    ? data.stuck_reason
    : typeof data.stuckReason === 'string'
      ? data.stuckReason
      : undefined;
  if (stuckReason) return stuckReason;

  const messageText = extractTaskMessageText(data.message);
  if (messageText) return messageText;

  const activeStepTitle = typeof data.active_step_title === 'string'
    ? data.active_step_title
    : typeof data.activeStepTitle === 'string'
      ? data.activeStepTitle
      : undefined;
  if (activeStepTitle) {
    return `Working on: ${activeStepTitle}.`;
  }

  const messageIndex = typeof data.message_index === 'number' ? data.message_index : undefined;
  const totalMessages = typeof data.total_messages === 'number' ? data.total_messages : undefined;
  const completedSteps = typeof data.completed_steps === 'number' ? data.completed_steps : undefined;
  const totalSteps = typeof data.total_steps === 'number' ? data.total_steps : undefined;

  if (typeof completedSteps === 'number' && typeof totalSteps === 'number' && totalSteps > 0) {
    return `Completed ${completedSteps} of ${totalSteps} builder steps.`;
  }

  if (typeof messageIndex === 'number' && typeof totalMessages === 'number' && totalMessages > 0) {
    return `Working through step ${messageIndex} of ${totalMessages}.`;
  }

  if (typeof messageIndex === 'number') {
    return `Working through step ${messageIndex}.`;
  }

  return undefined;
}

function parseBuilderTodos(data: unknown): BuilderTaskV1['todos'] | undefined {
  if (!Array.isArray(data)) {
    return undefined;
  }

  const todos = data
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.title !== 'string') return null;
      if (record.status !== 'not-started' && record.status !== 'in-progress' && record.status !== 'completed') {
        return null;
      }

      return {
        ...(typeof record.id === 'number' ? { id: record.id } : {}),
        title: record.title,
        status: record.status,
      } satisfies BuilderTodoRecord;
    })
    .filter((todo): todo is BuilderTodoRecord => Boolean(todo));

  return todos.length > 0 ? todos : undefined;
}

function mapBuilderTaskPhase(status: unknown): BuilderTaskV1['phase'] | null {
  switch (status) {
    case 'queued':
    case 'running':
    case 'started':
      return 'running';
    case 'completed':
    case 'synthesized':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function buildBuilderTaskEvent(
  phase: BuilderTaskV1['phase'],
  data: Record<string, unknown>,
  accumulator?: BuilderTaskAccumulator,
): BuilderTaskV1 {
  const taskId = typeof data.task_id === 'string' ? data.task_id : undefined;
  const label = typeof data.description === 'string' ? data.description : accumulator?.label;
  const messageIndex = typeof data.message_index === 'number' ? data.message_index : undefined;
  const totalMessages = typeof data.total_messages === 'number' ? data.total_messages : undefined;
  const progressPercent = typeof data.progress_percent === 'number'
    ? data.progress_percent
    : typeof data.progressPercent === 'number'
      ? data.progressPercent
      : undefined;
  const progressSource = data.progress_source === 'todos' || data.progress_source === 'messages' || data.progress_source === 'none'
    ? data.progress_source
    : data.progressSource === 'todos' || data.progressSource === 'messages' || data.progressSource === 'none'
      ? data.progressSource
      : undefined;
  const totalSteps = typeof data.total_steps === 'number' ? data.total_steps : undefined;
  const completedSteps = typeof data.completed_steps === 'number' ? data.completed_steps : undefined;
  const inProgressSteps = typeof data.in_progress_steps === 'number' ? data.in_progress_steps : undefined;
  const pendingSteps = typeof data.pending_steps === 'number' ? data.pending_steps : undefined;
  const activeStepTitle = typeof data.active_step_title === 'string'
    ? data.active_step_title
    : typeof data.activeStepTitle === 'string'
      ? data.activeStepTitle
      : undefined;
  const startedAt = typeof data.started_at === 'string' ? data.started_at : undefined;
  const completedAt = typeof data.completed_at === 'string' ? data.completed_at : undefined;
  const lastUpdateAt = typeof data.last_update_at === 'string' ? data.last_update_at : undefined;
  const lastProgressAt = typeof data.last_progress_at === 'string' ? data.last_progress_at : undefined;
  const heartbeatMs = typeof data.heartbeat_ms === 'number' ? data.heartbeat_ms : undefined;
  const idleMs = typeof data.idle_ms === 'number' ? data.idle_ms : undefined;
  const stuck = typeof data.is_stuck === 'boolean'
    ? data.is_stuck
    : typeof data.stuck === 'boolean'
      ? data.stuck
      : undefined;
  const stuckReason = typeof data.stuck_reason === 'string'
    ? data.stuck_reason
    : typeof data.stuckReason === 'string'
      ? data.stuckReason
      : undefined;
  const heartbeat = typeof data.heartbeat === 'boolean' ? data.heartbeat : undefined;
  const pollCount = typeof data.poll_count === 'number' ? data.poll_count : undefined;
  const todos = parseBuilderTodos(data.todos);

  let detail: string | undefined;
  switch (phase) {
    case 'running':
      detail = buildRunningTaskDetail(data);
      break;
    case 'completed':
      detail = 'Deliverable ready.';
      break;
    case 'failed':
      detail = typeof data.error === 'string'
        ? data.error
        : 'Builder failed before finishing the deliverable.';
      break;
    case 'timed_out':
      detail = 'Builder took too long and timed out.';
      break;
    case 'cancelled':
      detail = typeof data.error === 'string'
        ? data.error
        : 'Builder was cancelled before finishing the deliverable.';
      break;
  }

  return {
    phase,
    ...(taskId ? { taskId } : {}),
    ...(label ? { label } : {}),
    ...(detail ? { detail } : {}),
    ...(typeof messageIndex === 'number' ? { messageIndex } : {}),
    ...(typeof totalMessages === 'number' ? { totalMessages } : {}),
    ...(typeof progressPercent === 'number' ? { progressPercent } : {}),
    ...(progressSource ? { progressSource } : {}),
    ...(typeof totalSteps === 'number' ? { totalSteps } : {}),
    ...(typeof completedSteps === 'number' ? { completedSteps } : {}),
    ...(typeof inProgressSteps === 'number' ? { inProgressSteps } : {}),
    ...(typeof pendingSteps === 'number' ? { pendingSteps } : {}),
    ...(activeStepTitle ? { activeStepTitle } : {}),
    ...(todos ? { todos } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(lastUpdateAt ? { lastUpdateAt } : {}),
    ...(lastProgressAt ? { lastProgressAt } : {}),
    ...(typeof heartbeatMs === 'number' ? { heartbeatMs } : {}),
    ...(typeof idleMs === 'number' ? { idleMs } : {}),
    ...(typeof stuck === 'boolean' ? { stuck } : {}),
    ...(stuckReason ? { stuckReason } : {}),
    ...(typeof heartbeat === 'boolean' ? { heartbeat } : {}),
    ...(typeof pollCount === 'number' ? { pollCount } : {}),
  };
}

function extractValuesBuilderTask(data: unknown): BuilderTaskV1 | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const values = data as Record<string, unknown>;
  const nestedValues = values.values && typeof values.values === 'object'
    ? values.values as Record<string, unknown>
    : null;
  const rawBuilderTask = values.builder_task ?? values.builderTask ?? nestedValues?.builder_task ?? nestedValues?.builderTask;
  if (!rawBuilderTask || typeof rawBuilderTask !== 'object') {
    return null;
  }

  const builderTask = rawBuilderTask as Record<string, unknown>;
  const phase = mapBuilderTaskPhase(builderTask.status);
  if (!phase) {
    return null;
  }

  const label = typeof builderTask.description === 'string'
    ? builderTask.description
    : typeof builderTask.label === 'string'
      ? builderTask.label
      : undefined;

  return buildBuilderTaskEvent(phase, builderTask, label ? { label } : undefined);
}

export function createUIMessageStreamFromText(
  text: string,
  meta?: StreamMeta,
  artifacts?: Record<string, unknown> | null,
  builderArtifact?: unknown,
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

      const normalizedBuilderArtifact = normalizeBuilderArtifactPayload(builderArtifact);
      if (normalizedBuilderArtifact) {
        emit({ type: 'data-builderArtifactV1', data: normalizedBuilderArtifact });
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
export function createSSEToUIMessageStream(
  upstream: ReadableStream<Uint8Array>,
  initialMeta?: StreamMeta,
): ReadableStream<Uint8Array> {
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
  const activeToolCalls: Record<string, LangGraphToolAccumulator> = {};
  let sawArtifactTool = false;
  let sawBuilderArtifactTool = false;
  let finalArtifacts: Record<string, unknown> | null = null;
  let finalBuilderArtifact = null;
  let initialValuesArtifact: Record<string, unknown> | null = null;
  let initialValuesBuilderArtifact = null;
  const activeBuilderTasks = new Map<string, BuilderTaskAccumulator>();

  const meta: StreamMeta = { ...(initialMeta || {}) };

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let lastArtifactsSignature: string | null = null;
      let lastBuilderArtifactSignature: string | null = null;
      let lastBuilderTaskSignature: string | null = null;

      const emit = (payload: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encodeSseData(encoder, payload));
        } catch {
          isClosed = true;
        }
      };

      const emitArtifacts = (artifacts: Record<string, unknown>) => {
        const signature = JSON.stringify(artifacts);
        if (signature === lastArtifactsSignature) {
          return;
        }

        lastArtifactsSignature = signature;
        emit({ type: 'data-artifactsV1', data: artifacts });
      };

      const emitBuilderArtifact = (builderArtifact: unknown) => {
        const normalizedBuilderArtifact = normalizeBuilderArtifactPayload(builderArtifact);
        if (!normalizedBuilderArtifact) {
          return;
        }

        const signature = JSON.stringify(normalizedBuilderArtifact);
        if (signature === lastBuilderArtifactSignature) {
          return;
        }

        lastBuilderArtifactSignature = signature;
        emit({ type: 'data-builderArtifactV1', data: normalizedBuilderArtifact });
      };

      const emitBuilderTask = (builderTask: BuilderTaskV1) => {
        const signature = JSON.stringify(builderTask);
        if (signature === lastBuilderTaskSignature) {
          return;
        }

        lastBuilderTaskSignature = signature;
        emit({ type: 'data-builderTaskV1', data: builderTask });
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

            if (finalArtifacts) {
              emitArtifacts(finalArtifacts);
            }

            if (finalBuilderArtifact) {
              emitBuilderArtifact(finalBuilderArtifact);
            }

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
          buffer = buffer.replace(/\r\n/g, '\n');

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
                case 'messages':
                case 'messages-tuple': {
                  if (!Array.isArray(data) || data.length < 1) {
                    break;
                  }

                  const msg = data[0];
                  const metadata = data.length > 1 ? data[1] : undefined;
                  const runId = extractRunId(metadata);
                  if (runId) {
                    meta.run_id = runId;
                  }

                  if (!msg || typeof msg !== 'object') {
                    break;
                  }

                  const record = msg as Record<string, unknown>;
                  const msgType = typeof record.type === 'string' ? record.type : '';

                  if (msgType === 'tool') {
                    const toolName = typeof record.name === 'string' ? record.name : '';
                    if (toolName === 'emit_artifact') {
                      sawArtifactTool = true;
                      const artifact = parseAccumulatedArtifact(activeToolCalls);
                      const normalizedArtifact = normalizeArtifactsV1(artifact);
                      if (normalizedArtifact) {
                        finalArtifacts = normalizedArtifact;
                        emitArtifacts(normalizedArtifact);
                      }
                    } else if (toolName === 'emit_builder_artifact') {
                      sawBuilderArtifactTool = true;
                      const builderArtifact = parseAccumulatedBuilderArtifact(activeToolCalls);
                      if (builderArtifact) {
                        finalBuilderArtifact = builderArtifact;
                        emitBuilderArtifact(builderArtifact);
                      }
                    }
                    break;
                  }

                  if (!['AIMessageChunk', 'AIMessage', 'ai', 'assistant'].includes(msgType)) {
                    break;
                  }

                  const directArtifact = extractToolCallArtifact(record.tool_calls);
                  if (directArtifact) {
                    sawArtifactTool = true;
                    const normalizedArtifact = normalizeArtifactsV1(directArtifact);
                    if (normalizedArtifact) {
                      finalArtifacts = normalizedArtifact;
                      emitArtifacts(normalizedArtifact);
                    }
                  }

                  const directBuilderArtifact = extractToolCallBuilderArtifact(record.tool_calls);
                  if (directBuilderArtifact) {
                    sawBuilderArtifactTool = true;
                    finalBuilderArtifact = directBuilderArtifact;
                    emitBuilderArtifact(directBuilderArtifact);
                  }

                  const content = record.content;
                  if (typeof content === 'string' && content) {
                    const tokenText = sanitizeTokenChunkForOutput(content, leadFilterState, tokenOutputState);
                    if (tokenText) {
                      ensureStart();
                      emit({ type: 'text-delta', id: textId, delta: tokenText });
                      tokenCount++;
                    }
                    break;
                  }

                  if (!Array.isArray(content)) {
                    break;
                  }

                  for (const block of content) {
                    if (!block || typeof block !== 'object') continue;
                    const blockRecord = block as Record<string, unknown>;
                    const blockType = typeof blockRecord.type === 'string' ? blockRecord.type : '';

                    if (blockType === 'text') {
                      const tokenText = sanitizeTokenChunkForOutput(
                        String(blockRecord.text || ''),
                        leadFilterState,
                        tokenOutputState,
                      );
                      if (!tokenText) {
                        continue;
                      }

                      ensureStart();
                      emit({ type: 'text-delta', id: textId, delta: tokenText });
                      tokenCount++;
                      continue;
                    }

                    if (blockType === 'tool_use') {
                      const toolId = typeof blockRecord.id === 'string' ? blockRecord.id : '';
                      const toolName = typeof blockRecord.name === 'string' ? blockRecord.name : '';
                      if (toolName === 'emit_artifact') {
                        sawArtifactTool = true;
                      } else if (toolName === 'emit_builder_artifact') {
                        sawBuilderArtifactTool = true;
                      }
                      if (toolId) {
                        activeToolCalls[toolId] = { name: toolName, jsonParts: [] };
                      }
                      continue;
                    }

                    if (blockType === 'input_json_delta') {
                      const partialJson = typeof blockRecord.partial_json === 'string' ? blockRecord.partial_json : '';
                      if (!partialJson) continue;
                      for (const toolCall of Object.values(activeToolCalls).reverse()) {
                        toolCall.jsonParts.push(partialJson);
                        break;
                      }
                    }
                  }

                  break;
                }
                case 'values': {
                  const builderTask = extractValuesBuilderTask(data);
                  if (builderTask) {
                    emitBuilderTask(builderTask);
                  }

                  const builderArtifact = extractValuesBuilderArtifact(data);
                  if (builderArtifact !== null) {
                    const shouldEmitBuilderArtifact =
                      initialValuesBuilderArtifact === null ||
                      sawBuilderArtifactTool ||
                      builderArtifact !== initialValuesBuilderArtifact;

                    if (initialValuesBuilderArtifact === null) {
                      initialValuesBuilderArtifact = builderArtifact;
                    }

                    finalBuilderArtifact = builderArtifact;

                    if (shouldEmitBuilderArtifact) {
                      emitBuilderArtifact(builderArtifact);
                    }
                  }

                  const artifact = extractValuesArtifact(data);
                  if (!artifact) {
                    break;
                  }

                  if (initialValuesArtifact === null) {
                    initialValuesArtifact = artifact;
                  }

                  const normalizedArtifact = normalizeArtifactsV1(artifact);
                  if (!normalizedArtifact) {
                    break;
                  }

                  finalArtifacts = normalizedArtifact;

                  if (sawArtifactTool || artifact !== initialValuesArtifact) {
                    emitArtifacts(normalizedArtifact);
                  }

                  if (typeof artifact.skill_loaded === 'string') {
                    meta.skill_used = artifact.skill_loaded;
                  }
                  if (typeof artifact.voice_emotion_primary === 'string') {
                    meta.emotion_detected = artifact.voice_emotion_primary;
                  }
                  break;
                }
                case 'session_start':
                case 'agent_thinking':
                  break;
                case 'task_started': {
                  if (!data || typeof data !== 'object') {
                    break;
                  }

                  const taskData = data as Record<string, unknown>;
                  const taskId = typeof taskData.task_id === 'string' ? taskData.task_id : undefined;
                  const description = typeof taskData.description === 'string' ? taskData.description : undefined;
                  if (!isBuilderTaskDescription(description)) {
                    break;
                  }

                  if (taskId) {
                    activeBuilderTasks.set(taskId, { label: description });
                  }

                  emitBuilderTask(buildBuilderTaskEvent('running', taskData, { label: description }));
                  break;
                }
                case 'task_running': {
                  if (!data || typeof data !== 'object') {
                    break;
                  }

                  const taskData = data as Record<string, unknown>;
                  const taskId = typeof taskData.task_id === 'string' ? taskData.task_id : undefined;
                  if (!taskId) {
                    break;
                  }

                  const activeTask = activeBuilderTasks.get(taskId);
                  if (!activeTask) {
                    break;
                  }

                  emitBuilderTask(buildBuilderTaskEvent('running', taskData, activeTask));
                  break;
                }
                case 'task_completed': {
                  if (!data || typeof data !== 'object') {
                    break;
                  }

                  const taskData = data as Record<string, unknown>;
                  const taskId = typeof taskData.task_id === 'string' ? taskData.task_id : undefined;
                  if (!taskId) {
                    break;
                  }

                  const activeTask = activeBuilderTasks.get(taskId);
                  if (!activeTask) {
                    break;
                  }

                  emitBuilderTask(buildBuilderTaskEvent('completed', taskData, activeTask));
                  activeBuilderTasks.delete(taskId);
                  break;
                }
                case 'task_failed': {
                  if (!data || typeof data !== 'object') {
                    break;
                  }

                  const taskData = data as Record<string, unknown>;
                  const taskId = typeof taskData.task_id === 'string' ? taskData.task_id : undefined;
                  if (!taskId) {
                    break;
                  }

                  const activeTask = activeBuilderTasks.get(taskId);
                  if (!activeTask) {
                    break;
                  }

                  emitBuilderTask(buildBuilderTaskEvent('failed', taskData, activeTask));
                  activeBuilderTasks.delete(taskId);
                  break;
                }
                case 'task_timed_out': {
                  if (!data || typeof data !== 'object') {
                    break;
                  }

                  const taskData = data as Record<string, unknown>;
                  const taskId = typeof taskData.task_id === 'string' ? taskData.task_id : undefined;
                  if (!taskId) {
                    break;
                  }

                  const activeTask = activeBuilderTasks.get(taskId);
                  if (!activeTask) {
                    break;
                  }

                  emitBuilderTask(buildBuilderTaskEvent('timed_out', taskData, activeTask));
                  activeBuilderTasks.delete(taskId);
                  break;
                }
                case 'task_cancelled': {
                  if (!data || typeof data !== 'object') {
                    break;
                  }

                  const taskData = data as Record<string, unknown>;
                  const taskId = typeof taskData.task_id === 'string' ? taskData.task_id : undefined;
                  if (!taskId) {
                    break;
                  }

                  const activeTask = activeBuilderTasks.get(taskId);
                  if (!activeTask) {
                    break;
                  }

                  emitBuilderTask(buildBuilderTaskEvent('cancelled', taskData, activeTask));
                  activeBuilderTasks.delete(taskId);
                  break;
                }
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
                    emitArtifacts(normalizedArtifacts);
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
