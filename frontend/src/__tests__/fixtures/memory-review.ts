import type { MemoryReviewEnvelope } from '../../app/lib/memory-review-envelope';

export function reviewFixture(overrides: Partial<MemoryReviewEnvelope> = {}): MemoryReviewEnvelope {
  return { schema: 'mem00.review.v2', memory_contract_epoch: 1, owner_id: 'owner', session_id: 'session', thread_id: 'thread',
    transcript_revision: 1, source_manifest_ref: 'hmac-sha256:synthetic:manifest', target_sequence_start: 1, target_sequence_end: 1,
    finalization: { kind: 'source_target_receipt', status: 'ended', ended_at: '2026-09-09T00:00:00Z',
      event_id: '00000000-0000-4000-8000-000000000001', transcript_revision: 1, source_manifest_ref: 'hmac-sha256:synthetic:manifest' }, snapshot_id: 'a'.repeat(32),
    review_filter: 'pending_review', extraction_state: 'complete', source_eligibility: { memory_clear_epoch: 0, source_snapshot_id: 'mem00-source-snapshot-' + 'a'.repeat(32), visible_message_count: 1, eligible_message_count: 1, before_clear_count: 0, accepted_version_changed_count: 0, acceptance_unproven_count: 0 },
    target_message_count: 1, covered_message_count: 1, run_count: 1,
    summary: { scope: 'session_history', produced: 0, pending: 0, approved: 0, rejected: 0, invalidated: 0 },
    candidates: [], enumeration_complete: true, next_cursor: null, retryable: false, recovery_action: 'none', ...overrides };
}
