import type { MemoryReviewEnvelope } from '../../app/lib/memory-review-envelope';
import { reviewFixture } from '../fixtures/memory-review';

export type CanonicalFixtureState = 'awaiting_finalization' | 'processing' | 'complete';

export function canonicalCandidate(n: number, content = `Synthetic candidate ${n}`) {
  return {
    candidate_id: `00000000-0000-4000-8000-00000000010${n}`, candidate_revision: 1, review_state: 'pending_review' as const,
    content, category: 'fact', extraction_run_id: '00000000-0000-4000-8000-000000000200',
    source_manifest_ref: 'hmac-sha256:synthetic:manifest', sequence_start: 1, sequence_end: 1,
  };
}

/** A schema-valid canonical recap body, as the Next recap route returns it. */
export function canonicalRecap(
  sessionId: string,
  state: CanonicalFixtureState,
  { candidates = [], summary = {}, ownerId = 'owner' }: {
    candidates?: ReturnType<typeof canonicalCandidate>[];
    summary?: Partial<MemoryReviewEnvelope['summary']>;
    ownerId?: string;
  } = {},
) {
  const review = reviewFixture({
    owner_id: ownerId, session_id: sessionId, extraction_state: state,
    covered_message_count: state === 'complete' ? 1 : 0, run_count: state === 'complete' ? 1 : 0,
    candidates,
    summary: { scope: 'session_history', produced: candidates.length, pending: candidates.length, approved: 0, rejected: 0, invalidated: 0, ...summary },
    retryable: state !== 'complete', recovery_action: state === 'complete' ? 'none' : 'await_or_recover_extraction',
    ...(state === 'awaiting_finalization'
      ? { finalization: { kind: 'source_target_receipt' as const, status: null, ended_at: null, event_id: null, transcript_revision: null, source_manifest_ref: null } }
      : {}),
  });
  return { session_id: sessionId, thread_id: review.thread_id, status: state, ended_at: review.finalization.ended_at, memory_review: review };
}
