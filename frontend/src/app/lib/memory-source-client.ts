import { z } from 'zod';

import { sourceActionReceiptSchema, sourceActionSchema, sourceProfileSchema, sourceUuid, type SourceActionReceipt, type SourceProfile } from './memory-source-contract';

// Transport metadata for an explicit source action, not memory authority. Store
// retries alongside the existing source queue, never in a new memory ledger.
export const sourceSendIntentSchema = z.strictObject({
  owner_id: z.string().min(1), session_id: sourceUuid, action: sourceActionSchema,
  attachments: z.never().optional(),
});
export type SourceSendIntent = z.infer<typeof sourceSendIntentSchema>;
export type SourceSendInput = { text: string; sourceIntent?: SourceSendIntent };

export function createSourceSendIntent(profile: SourceProfile, text: string, uploads: readonly unknown[] = []): SourceSendIntent | null {
  // Optional source upload intake is unavailable in C2, including retries.
  if (uploads.length) throw new Error('memory_source_upload_unavailable');
  const current = sourceProfileSchema.parse(profile);
  if (current.authority === 'legacy') {
    if (uploads.length) throw new Error('memory_source_profile_unavailable');
    return null;
  }
  if (!current.boundary) throw new Error('memory_source_profile_unavailable');
  const intent = sourceSendIntentSchema.parse({ owner_id: current.owner_id, session_id: current.session_id,
    action: { thread_id: current.thread_id, command_key: crypto.randomUUID(), message_id: crypto.randomUUID(),
      expected_clear_epoch: current.boundary.memory_clear_epoch, content: text },
  });
  Object.freeze(intent.action);
  return Object.freeze(intent);
}

async function readBounded(response: Response): Promise<unknown> {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('memory_source_unavailable');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32768) throw new Error('memory_source_unavailable');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function loadSourceProfile(owner: string, session: string, thread: string, signal?: AbortSignal): Promise<SourceProfile> {
  try {
    sourceUuid.parse(session); sourceUuid.parse(thread);
    const response = await fetch(`/api/sessions/${encodeURIComponent(session)}/memory-source-profile?thread_id=${encodeURIComponent(thread)}`,
      { cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    const result = sourceProfileSchema.parse(await readBounded(response));
    if (result.owner_id !== owner || result.session_id !== session || result.thread_id !== thread) throw new Error('scope');
    return result;
  } catch { throw new Error('memory_source_profile_unavailable'); }
}

/** A retry posts the exact original key/content/epoch, never a new boundary. */
export async function recordSourceSendIntent(value: SourceSendIntent): Promise<SourceActionReceipt> {
  try {
    const intent = sourceSendIntentSchema.parse(value), action = intent.action;
    const response = await fetch(`/api/sessions/${encodeURIComponent(intent.session_id)}/memory-source-actions`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action),
    });
    const result = sourceActionReceiptSchema.parse(await readBounded(response));
    if (result.owner_id !== intent.owner_id || result.session_id !== intent.session_id || result.thread_id !== action.thread_id
      || result.message_id !== action.message_id || result.command_key !== action.command_key || result.memory_clear_epoch !== action.expected_clear_epoch) throw new Error('scope');
    return result;
  } catch { throw new Error('memory_source_action_unavailable'); }
}
