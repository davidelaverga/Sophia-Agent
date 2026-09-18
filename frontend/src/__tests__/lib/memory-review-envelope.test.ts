import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryReviewEnvelopeSchema, readRemainingReviewPages } from '../../app/lib/memory-review-envelope';

import { reviewFixture } from '../fixtures/memory-review';

function candidate(n: number) {
  return { candidate_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, candidate_revision: 1,
    review_state: 'pending_review' as const, content: `SYNTHETIC-${n}`, category: 'fact', extraction_run_id: '00000000-0000-4000-8000-000000009999',
    source_manifest_ref: 'hmac-sha256:synthetic:manifest', sequence_start: 1, sequence_end: 1 };
}

describe('canonical review snapshot pages', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['missing', 'partition', 'epoch', 'zero_claim', 'excluded_with_candidates'])('rejects invalid source eligibility: %s', (fault) => {
    const value = reviewFixture();
    const source = { ...value.source_eligibility };
    if (fault === 'partition') source.before_clear_count = 1;
    if (fault === 'epoch') source.memory_clear_epoch = -1;
    if (fault === 'zero_claim' || fault === 'excluded_with_candidates') {
      source.eligible_message_count = 0; source.before_clear_count = 1;
      value.target_message_count = 0; value.covered_message_count = 0;
    }
    if (fault === 'excluded_with_candidates') {
      value.extraction_state = 'source_excluded'; value.candidates = [candidate(1)];
      value.summary = { scope: 'session_history', produced: 1, pending: 1, approved: 0, rejected: 0, invalidated: 0 };
    }
    expect(memoryReviewEnvelopeSchema.safeParse({ ...value, source_eligibility: fault === 'missing' ? undefined : source }).success).toBe(false);
  });
  it('accepts an explicit excluded source state without claiming successful zero', () => {
    const value = reviewFixture({ extraction_state: 'source_excluded', target_message_count: 0, covered_message_count: 0,
      source_eligibility: { ...reviewFixture().source_eligibility, eligible_message_count: 0, before_clear_count: 1 } });
    expect(memoryReviewEnvelopeSchema.parse(value).extraction_state).toBe('source_excluded');
  });
  it.each(['event_id', 'transcript_revision', 'source_manifest_ref', 'status', 'ended_at'] as const)('rejects a complete claim without matching finalization %s', (field) => {
    const value = reviewFixture();
    const finalization = { ...value.finalization, [field]: null };
    expect(memoryReviewEnvelopeSchema.safeParse({ ...value, finalization }).success).toBe(false);
  });
  it('enumerates 1005 exact candidates across one snapshot, without legacy memory fetches', async () => {
    const pages = Array.from({ length: 6 }, (_, page) => reviewFixture({
      summary: { scope: 'session_history', produced: 1005, pending: 1005, approved: 0, rejected: 0, invalidated: 0 },
      candidates: Array.from({ length: Math.min(200, 1005 - page * 200) }, (_, index) => candidate(page * 200 + index + 1)),
      enumeration_complete: page === 5, next_cursor: page === 5 ? null : `cursor-${page + 1}`,
    }));
    let index = 1;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ memory_review: pages[index++] })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await readRemainingReviewPages(memoryReviewEnvelopeSchema.parse(pages[0]), 'session', new AbortController().signal);
    expect(result.candidates).toHaveLength(1005);
    expect(new Set(result.candidates.map((item) => item.candidate_id)).size).toBe(1005);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.every((args) => String(args[0]).startsWith('/api/sophia/sessions/session/recap?cursor='))).toBe(true);
  });
  it.each(['snapshot', 'owner', 'duplicate', 'missing', 'source_epoch', 'coverage'])('rejects %s drift without publishing a mixed result', async (fault) => {
    const first = reviewFixture({ summary: { scope: 'session_history', produced: 2, pending: 2, approved: 0, rejected: 0, invalidated: 0 },
      candidates: [candidate(1)], enumeration_complete: false, next_cursor: 'second-page' });
    const second = { ...first, candidates: fault === 'missing' ? [] : [candidate(fault === 'duplicate' ? 1 : 2)], enumeration_complete: true, next_cursor: null,
      snapshot_id: fault === 'snapshot' ? 'b'.repeat(32) : first.snapshot_id, owner_id: fault === 'owner' ? 'another-owner' : first.owner_id,
      source_eligibility: { ...first.source_eligibility, memory_clear_epoch: fault === 'source_epoch' ? 1 : 0 },
      run_count: fault === 'coverage' ? 2 : first.run_count };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ memory_review: second }))));
    await expect(readRemainingReviewPages(first, 'session', new AbortController().signal)).rejects.toThrow();
  });
  it('rejects a complete state with incomplete coverage', () => {
    expect(memoryReviewEnvelopeSchema.safeParse(reviewFixture({ covered_message_count: 0 })).success).toBe(false);
  });
});
