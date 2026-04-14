import { normalizeBuilderArtifactPayload } from '../lib/builder-artifacts';
import { asRecord, readNumber, readString } from '../lib/record-parsers';
import { InterruptPayloadSchema } from '../lib/schemas/session-schemas';
import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type { BuilderTaskPhaseV1, BuilderTaskV1 } from '../types/builder-task';
import type { InterruptPayload } from '../types/session';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';

export type StreamArtifactsPayload = {
  takeaway?: string;
  reflection_candidate?: string | { prompt?: string; why?: string };
  reflection?: string | { prompt?: string; why?: string };
  memory_candidates?: unknown[];
  [key: string]: unknown;
};

export type StreamContractPart = {
  type: string;
  data: unknown;
};

const BUILDER_TASK_PHASE_MAP = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed_out',
  cancelled: 'cancelled',
  task_started: 'running',
  task_running: 'running',
  task_completed: 'completed',
  task_failed: 'failed',
  task_timed_out: 'timed_out',
  task_cancelled: 'cancelled',
} as const satisfies Record<string, BuilderTaskPhaseV1>;

export function normalizeStreamDataPart(dataPart: unknown): StreamContractPart | null {
  const part = asRecord(dataPart);
  if (!part) return null;

  const rawType = typeof part.type === 'string' ? part.type : '';
  const normalizedType = rawType.startsWith('data-') ? rawType.slice(5) : rawType;

  return {
    type: normalizedType,
    data: part.data,
  };
}

export function parseArtifactsPayload(data: unknown): StreamArtifactsPayload | null {
  const record = asRecord(data);
  if (!record) return null;

  const payload: StreamArtifactsPayload = { ...record };

  if (payload.takeaway !== undefined && typeof payload.takeaway !== 'string') {
    delete payload.takeaway;
  }

  if (
    payload.reflection_candidate !== undefined &&
    typeof payload.reflection_candidate !== 'string' &&
    (typeof payload.reflection_candidate !== 'object' || payload.reflection_candidate === null)
  ) {
    delete payload.reflection_candidate;
  }

  if (
    payload.reflection !== undefined &&
    typeof payload.reflection !== 'string' &&
    (typeof payload.reflection !== 'object' || payload.reflection === null)
  ) {
    delete payload.reflection;
  }

  if (payload.memory_candidates !== undefined && !Array.isArray(payload.memory_candidates)) {
    delete payload.memory_candidates;
  }

  return payload;
}

export function parseBuilderArtifactPayload(data: unknown): BuilderArtifactV1 | null {
  return normalizeBuilderArtifactPayload(data);
}

export function parseBuilderTaskPayload(data: unknown): BuilderTaskV1 | null {
  const record = asRecord(data);
  if (!record) return null;

  const rawPhase = readString(record, 'phase') ?? readString(record, 'type');
  const phase = rawPhase ? BUILDER_TASK_PHASE_MAP[rawPhase] : undefined;
  if (!phase) {
    return null;
  }

  const taskId = readString(record, 'taskId') ?? readString(record, 'task_id');
  const label = readString(record, 'label') ?? readString(record, 'description');
  const detail = readString(record, 'detail')
    ?? (rawPhase === 'task_started' ? 'Builder is working on the deliverable.' : undefined);
  const messageIndex = readNumber(record, 'messageIndex') ?? readNumber(record, 'message_index');
  const totalMessages = readNumber(record, 'totalMessages') ?? readNumber(record, 'total_messages');

  return {
    phase,
    ...(taskId ? { taskId } : {}),
    ...(label ? { label } : {}),
    ...(detail ? { detail } : {}),
    ...(typeof messageIndex === 'number' ? { messageIndex } : {}),
    ...(typeof totalMessages === 'number' ? { totalMessages } : {}),
  };
}

function normalizeInterruptAliases(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw };

  if (normalized.snooze === undefined && normalized.snooze_enabled !== undefined) {
    normalized.snooze = normalized.snooze_enabled;
  }

  if (normalized.expiresAt === undefined && normalized.expires_at !== undefined) {
    normalized.expiresAt = normalized.expires_at;
  }

  if (normalized.dialogKind === undefined && normalized.dialog_kind !== undefined) {
    normalized.dialogKind = normalized.dialog_kind;
  }

  return normalized;
}

export function parseInterruptPayload(data: unknown): InterruptPayload | null {
  const record = asRecord(data);
  if (!record) return null;

  const normalized = normalizeInterruptAliases(record);
  const parsed = InterruptPayloadSchema.safeParse(normalized);
  if (!parsed.success) return null;

  return parsed.data as InterruptPayload;
}

export function extractStreamMetadata(
  data: unknown,
  previous: Partial<SophiaMessageMetadata>
): Partial<SophiaMessageMetadata> {
  const meta = asRecord(data);
  if (!meta) return previous;

  return {
    thread_id: readString(meta, 'thread_id') ?? previous.thread_id,
    run_id: readString(meta, 'run_id') ?? previous.run_id,
    session_id: readString(meta, 'session_id') ?? previous.session_id,
    skill_used: readString(meta, 'skill_used') ?? previous.skill_used,
    emotion_detected: readString(meta, 'emotion_detected') ?? previous.emotion_detected,
  };
}