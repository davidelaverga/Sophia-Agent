import { z } from 'zod';

import type { JournalEntry } from './journal';
import { commandReceiptSchema } from './memory-command-receipt';
import { memoryInventoryRecordSchema } from './memory-inventory-envelope';

const revision = z.number().int().safe().positive();
export const currentMemoryViewSchema = z.object({
  schema: z.literal('mem00.current-memory.v1'), owner_id: z.string().min(1), memory_id: z.string().uuid(),
  status: z.enum(['available', 'not_found', 'unavailable']), lifecycle: z.enum(['active', 'forgotten', 'tombstoned']).nullable(),
  content_revision: revision.nullable(), memory_governance_revision: revision.nullable(),
  memory: memoryInventoryRecordSchema.nullable(), provider_state_queried: z.literal(false), current_view_only: z.literal(true),
}).superRefine((value, context) => {
  const invalid = value.status !== 'available'
    ? [value.lifecycle, value.content_revision, value.memory_governance_revision, value.memory].some((item) => item !== null)
    : !value.lifecycle || !value.content_revision || !value.memory_governance_revision
      || (value.lifecycle === 'tombstoned' ? value.memory !== null : value.memory?.kind !== 'memory'
        || value.memory.id !== value.memory_id || value.memory.state !== value.lifecycle
        || value.memory.revision !== value.content_revision || value.memory.memory_governance_revision !== value.memory_governance_revision);
  if (invalid) context.addIssue({ code: 'custom', message: 'Current memory view unavailable' });
});

const deletionDispositionSchema = z.object({
  scope: z.literal('canonical_memory_only'), canonical_fence: z.literal('committed_in_original_receipt'),
  canonical_plaintext_erasure: z.literal('not_verified_in_this_response'), provider_cleanup: z.literal('not_verified_in_this_response'),
  derived_invalidation: z.literal('not_verified_in_this_response'), managed_browser_erasure: z.literal('not_verified_in_this_response'),
  source_transcript: z.literal('not_deleted_by_this_command'), other_account_data: z.literal('not_covered_by_mem00'),
  verification_as_of: z.null(), provider_state_queried: z.literal(false),
});

export const canonicalCommandResultSchema = z.object({
  schema: z.literal('mem00.command-result.v1'), owner_id: z.string().min(1), command_key: z.string().min(8).max(200),
  status: z.literal('committed'), historical_result_only: z.literal(true), receipt: commandReceiptSchema,
  current_view: currentMemoryViewSchema,
  privacy_disposition: deletionDispositionSchema.nullish(),
}).superRefine((value, context) => {
  if (value.owner_id !== value.current_view.owner_id || value.receipt.memory_id !== value.current_view.memory_id) {
    context.addIssue({ code: 'custom', message: 'Command result scope unavailable' });
  }
  const deleted = value.receipt.event_type === 'memory_tombstoned';
  if (deleted !== Boolean(value.privacy_disposition) || (deleted && (value.receipt.resulting_lifecycle !== 'tombstoned'
    || !value.receipt.tombstone_id || value.receipt.status !== 'accepted_and_fenced'))) {
    context.addIssue({ code: 'custom', message: 'Deletion disposition unavailable' });
  }
  if (value.current_view.status === 'available' && ((deleted && value.current_view.lifecycle !== 'tombstoned')
    || (value.current_view.content_revision ?? 0) < (value.receipt.content_revision ?? 0)
    || (value.current_view.memory_governance_revision ?? 0) < (value.receipt.memory_governance_revision ?? 0))) {
    context.addIssue({ code: 'custom', message: 'Current memory view precedes command' });
  }
});
export type CanonicalCommandResult = z.infer<typeof canonicalCommandResultSchema>;

export function currentCommandJournalEntry(result: CanonicalCommandResult, shelf: 'active' | 'forgotten'): JournalEntry | null {
  const view = result.current_view;
  if (view.status !== 'available' || view.lifecycle !== shelf || !view.memory) return null;
  const memory = view.memory;
  if (!memory.content) return null;
  return { id: memory.id, content: memory.content, category: memory.category, created_at: memory.created_at,
    metadata: { authority: 'sophia_canonical', lifecycle: memory.state, tier: memory.user_tier, scope: memory.scope,
      content_revision: memory.revision, memory_governance_revision: memory.memory_governance_revision,
      projection_state: 'unavailable' } };
}
