import { InterruptPayloadSchema } from '../lib/schemas/session-schemas';
import { asRecord, readString } from '../lib/record-parsers';
import type { InterruptPayload } from '../types/session';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';

export type StreamArtifactsPayload = {
  takeaway?: string;
  reflection_candidate?: string | { prompt?: string; why?: string };
  memory_candidates?: unknown[];
  [key: string]: unknown;
};

export type StreamContractPart = {
  type: string;
  data: unknown;
};

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

  if (payload.memory_candidates !== undefined && !Array.isArray(payload.memory_candidates)) {
    delete payload.memory_candidates;
  }

  return payload;
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