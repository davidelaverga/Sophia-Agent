/**
 * MEM00-C2 WP1 composed exit evidence.
 *
 * Wires the REAL commit-candidates route handler to the REAL recap store so the
 * decision envelope contract is verified end-to-end instead of being assumed
 * independently on both sides. Only the network hops are stubbed: the Gateway
 * bulk-review call and the browser command-receipt read, following the
 * repository's established mocking convention.
 *
 * Proves: a successful SQL decision whose response is lost/unjoined is recovered
 * from its original command receipt with no second mutation and no resurrection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));

vi.mock('../../app/api/_lib/sophia', () => ({
  fetchSophiaApi: (...args: unknown[]) => upstream(...args),
  resolveSophiaUserId: async () => 'review-owner',
}));
vi.mock('../../server/voice-lab/ordinary-route-isolation', () => ({
  voiceLabOrdinaryProductBoundaryResponse: vi.fn(async () => null),
}));
vi.mock('../../app/lib/error-logger', () => ({ logger: { logError: vi.fn() } }));
vi.mock('../../app/stores/session-history-store', () => ({
  useSessionHistoryStore: { getState: () => ({ markMemoriesApproved: vi.fn() }) },
}));

import { POST } from '../../app/api/memory/commit-candidates/route';
import { useRecapStore } from '../../app/stores/recap-store';

const receipt = {
  event_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  operation_id: 'recap:review-session:candidate-b:2:operation',
  event_type: 'candidate_approved',
  resulting_lifecycle: 'active',
  candidate_id: 'candidate-b',
  user_catalog_generation: 1,
  user_revocation_epoch: 0,
  idempotent_replay: true,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function seedTwoApprovedCandidates() {
  const store = useRecapStore.getState();
  store.setArtifacts('review-session', {
    sessionId: 'review-session',
    sessionType: 'open',
    contextMode: 'life',
    status: 'ready',
    memoryCandidates: [
      { id: 'candidate-a', text: 'Synthetic fact A', category: 'fact', candidateRevision: 2 },
      { id: 'candidate-b', text: 'Synthetic fact B', category: 'fact', candidateRevision: 2 },
    ],
  });
  store.setDecision('review-session', 'candidate-a', 'approved');
  store.setDecision('review-session', 'candidate-b', 'approved');
}

describe('MEM00-C2 WP1 composed decision and lost-response recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useRecapStore.setState({ artifacts: {}, decisions: {}, commitStatus: {} });
  });

  it('commits through the real route, then recovers a lost success without a second mutation', async () => {
    // The Gateway committed BOTH decisions, but its response only carried
    // candidate-a: candidate-b's successful result was lost in transit.
    upstream.mockImplementation(async (url: string, init: { body: string }) => {
      expect(url).toBe('/api/sophia/review-owner/memories/bulk-review');
      const items = JSON.parse(init.body).items;
      expect(items.map((i: { id: string }) => i.id).sort()).toEqual(['candidate-a', 'candidate-b']);
      return json({ results: [{ id: 'candidate-a', action: 'approve', status: 'ok' }] });
    });

    const bulkReviewCalls: string[] = [];
    const receiptCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === '/api/memory/commit-candidates') {
        bulkReviewCalls.push(url);
        // Drive the REAL route handler and return its actual response.
        return POST({ json: async () => JSON.parse(String(init?.body ?? '{}')) } as never);
      }
      if (url.startsWith('/api/memory/commands/')) {
        receiptCalls.push(url);
        return json({ status: 'committed', historical_result_only: true, receipt });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    seedTwoApprovedCandidates();
    const result = await useRecapStore.getState().commitMemories('review-session', 'thread-1');

    // Exactly one bulk-review mutation: recovery read the receipt, never re-posted.
    expect(bulkReviewCalls).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(1);
    // The lost decision was recovered through its own original command key.
    expect(receiptCalls).toHaveLength(1);
    expect(decodeURIComponent(receiptCalls[0])).toContain('recap:review-session:candidate-b:2:');

    expect(result.committed.sort()).toEqual(['candidate-a', 'candidate-b']);
    expect(result.errors).toEqual([]);
    expect(result.ambiguous).toEqual([]);

    const state = useRecapStore.getState();
    expect(state.getCommitStatus('review-session')).toBe('committed');
    expect(state.getDecisionForCandidate('review-session', 'candidate-a')?.status).toBe('committed');
    expect(state.getDecisionForCandidate('review-session', 'candidate-b')?.status).toBe('committed');
    // No memory text was persisted as current authority.
    expect(JSON.parse(localStorage.getItem('sophia-recap')!).state).toEqual({});
  });

  it('excludes a superseded canonical revision from the committed decision view', async () => {
    // Current-view check paired with the recovery case: when the canonical
    // revision changes before commit, the stale decision is dropped rather than
    // being presented as current authority or replayed against the new revision.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/memory/commands/')) {
        return json({ status: 'not_found', historical_result_only: true, receipt: null });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const store = useRecapStore.getState();
    store.setArtifacts('review-session', {
      sessionId: 'review-session', sessionType: 'open', contextMode: 'life', status: 'ready',
      memoryCandidates: [{ id: 'candidate-a', text: 'Synthetic fact A', category: 'fact', candidateRevision: 2 }],
    });
    store.setDecision('review-session', 'candidate-a', 'approved');
    expect(store.getApprovedCandidates('review-session')).toHaveLength(1);

    // A newer canonical revision arrives before the decision is committed.
    useRecapStore.getState().setArtifacts('review-session', {
      sessionId: 'review-session', sessionType: 'open', contextMode: 'life', status: 'ready',
      memoryCandidates: [{ id: 'candidate-a', text: 'Superseding revision', category: 'fact', candidateRevision: 3 }],
    });

    // The stale revision-2 decision is no longer eligible, so nothing mutates.
    expect(useRecapStore.getState().getApprovedCandidates('review-session')).toEqual([]);
    const result = await useRecapStore.getState().commitMemories('review-session');
    expect(result).toMatchObject({ committed: [], discarded: [], errors: [] });
    expect(upstream).not.toHaveBeenCalled();
  });

});
