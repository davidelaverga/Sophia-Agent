import { z } from 'zod';

const count = z.number().int().safe().nonnegative();
export const memoryReviewEnvelopeSchema = z.object({
  schema: z.literal('mem00.review.v2'), memory_contract_epoch: z.literal(1),
  owner_id: z.string().min(1), session_id: z.string().min(1), thread_id: z.string().nullable(),
  transcript_revision: count, source_manifest_ref: z.string().min(1),
  target_sequence_start: count.nullable(), target_sequence_end: count.nullable(),
  finalization: z.object({ kind: z.literal('source_target_receipt'), status: z.string().nullable(), ended_at: z.string().nullable(),
    event_id: z.string().uuid().nullable(), transcript_revision: count.nullable(), source_manifest_ref: z.string().nullable() }),
  snapshot_id: z.string().regex(/^[a-f0-9]{32}$/), review_filter: z.literal('pending_review'),
  extraction_state: z.enum(['awaiting_finalization', 'processing', 'complete', 'source_excluded', 'failed_retryable', 'failed_terminal', 'unavailable', 'not_found', 'source_changed', 'snapshot_changed']),
  source_eligibility: z.object({ memory_clear_epoch: count, source_snapshot_id: z.string().regex(/^mem00-source-snapshot-[a-f0-9]{32}$/),
    visible_message_count: count, eligible_message_count: count, before_clear_count: count,
    accepted_version_changed_count: count, acceptance_unproven_count: count }),
  target_message_count: count, covered_message_count: count, run_count: count,
  summary: z.object({ scope: z.literal('session_history'), produced: count, pending: count, approved: count, rejected: count, invalidated: count }),
  candidates: z.array(z.object({ candidate_id: z.string().uuid(), candidate_revision: count.positive(),
    review_state: z.literal('pending_review'), content: z.string().min(1), category: z.string(), extraction_run_id: z.string().uuid(),
    source_manifest_ref: z.string().min(1), sequence_start: count.positive(), sequence_end: count.positive() })),
  enumeration_complete: z.boolean(), next_cursor: z.string().min(1).max(512).nullable(),
  retryable: z.boolean(), recovery_action: z.enum(['refresh_view', 'await_or_recover_extraction', 'retry_extraction', 'finalize_source', 'inspect_failure', 'none']),
}).superRefine((value, context) => {
  if (['complete', 'source_excluded', 'processing', 'failed_retryable', 'failed_terminal'].includes(value.extraction_state)
    && (!value.finalization.event_id || value.finalization.status !== 'ended' || !value.finalization.ended_at
      || value.finalization.transcript_revision !== value.transcript_revision || value.finalization.source_manifest_ref !== value.source_manifest_ref)) {
    context.addIssue({ code: 'custom', message: 'Canonical source finalization unproven' });
  }
  const source = value.source_eligibility;
  if (source.visible_message_count !== source.eligible_message_count + source.before_clear_count
    + source.accepted_version_changed_count + source.acceptance_unproven_count
    || value.target_message_count !== source.eligible_message_count
    || (value.extraction_state === 'complete' && source.visible_message_count > 0 && source.eligible_message_count === 0)
    || (value.extraction_state === 'source_excluded' && (source.visible_message_count === 0
      || source.eligible_message_count !== 0 || value.covered_message_count !== 0 || value.summary.pending !== 0 || value.candidates.length !== 0))) {
    context.addIssue({ code: 'custom', message: 'Canonical source eligibility unproven' });
  }
  if (value.covered_message_count > value.target_message_count
    || (value.extraction_state === 'complete' && value.covered_message_count !== value.target_message_count)
    || value.summary.pending < value.candidates.length
    || value.summary.produced < value.summary.pending
    || value.enumeration_complete !== (value.next_cursor === null)
    || new Set(value.candidates.map((item) => item.candidate_id)).size !== value.candidates.length) {
    context.addIssue({ code: 'custom', message: 'Canonical review integrity unavailable' });
  }
});

export type MemoryReviewEnvelope = z.infer<typeof memoryReviewEnvelopeSchema>;

/** Complete one snapshot only. A changed/partial page never becomes a merged view. */
export async function readRemainingReviewPages(first: MemoryReviewEnvelope, sessionId: string, signal: AbortSignal): Promise<MemoryReviewEnvelope> {
  const candidates = [...first.candidates];
  const ids = new Set(candidates.map((item) => item.candidate_id));
  const cursors = new Set<string>();
  let page = first;
  while (!page.enumeration_complete) {
    const cursor = page.next_cursor;
    if (!cursor || cursors.has(cursor) || cursors.size > first.summary.pending) throw new Error('Review enumeration unavailable');
    cursors.add(cursor);
    const response = await fetch(`/api/sophia/sessions/${encodeURIComponent(sessionId)}/recap?cursor=${encodeURIComponent(cursor)}`, { method: 'GET', cache: 'no-store', signal });
    if (!response.ok) throw new Error('Review snapshot changed or unavailable');
    const payload = await response.json() as { memory_review?: unknown };
    page = memoryReviewEnvelopeSchema.parse(payload.memory_review);
    if (page.owner_id !== first.owner_id || page.session_id !== sessionId || page.snapshot_id !== first.snapshot_id
      || page.source_manifest_ref !== first.source_manifest_ref || page.transcript_revision !== first.transcript_revision
      || JSON.stringify(page.finalization) !== JSON.stringify(first.finalization)
      || JSON.stringify(page.source_eligibility) !== JSON.stringify(first.source_eligibility)
      || page.target_message_count !== first.target_message_count || page.covered_message_count !== first.covered_message_count
      || page.target_sequence_start !== first.target_sequence_start || page.target_sequence_end !== first.target_sequence_end || page.run_count !== first.run_count
      || page.extraction_state !== first.extraction_state || JSON.stringify(page.summary) !== JSON.stringify(first.summary)) {
      throw new Error('Review snapshot changed');
    }
    for (const item of page.candidates) {
      if (ids.has(item.candidate_id)) throw new Error('Review page repeated');
      ids.add(item.candidate_id); candidates.push(item);
    }
  }
  if (candidates.length !== first.summary.pending) throw new Error('Review enumeration incomplete');
  return { ...first, candidates, enumeration_complete: true, next_cursor: null };
}
