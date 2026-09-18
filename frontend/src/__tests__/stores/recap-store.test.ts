import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: vi.fn(),
  },
}));

import type { RecapArtifactsV1 } from '../../app/lib/recap-types';
import { useRecapStore } from '../../app/stores/recap-store';

const fixture = (sessionId: string, candidateRevision = 1): RecapArtifactsV1 => ({
  sessionId, sessionType: 'open', contextMode: 'life', status: 'ready',
  memoryCandidates: [{ id: 'candidate', text: 'Synthetic certification fixture', category: 'fact', candidateRevision }],
});

describe('Recap Store', () => {
  it('does not publish a delayed commit result after its action lifetime ends', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const store = useRecapStore.getState();
    store.setArtifacts('s', fixture('s'));
    store.setDecision('s', 'candidate', 'approved');
    let current = true;
    const pending = store.commitMemories('s', undefined, () => current);
    current = false;
    store.invalidateSession('s');
    finish(new Response(JSON.stringify({ committed: ['candidate'], discarded: [], errors: [] })));
    await expect(pending).rejects.toThrow('recap_action_context_changed');
    expect(useRecapStore.getState().commitStatus).toEqual({});
    expect(useRecapStore.getState().decisions).toEqual({});
  });
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useRecapStore.setState({
      artifacts: {},
      decisions: {},
      commitStatus: {},
    });
  });

  it('never persists memory text, decisions or commit state', () => {
    const store = useRecapStore.getState();
    store.setArtifacts('private-session', fixture('private-session'));
    store.setDecision('private-session', 'candidate', 'edited', 'SYNTHETIC PRIVATE EDIT');
    useRecapStore.setState({ commitStatus: { 'private-session': 'committed' } });
    const saved = JSON.parse(localStorage.getItem('sophia-recap')!);
    expect(saved.state).toEqual({});
    expect(store.getArtifacts('private-session')).toBeDefined();
  });

  it('discards old persisted recap data without touching unrelated drafts', async () => {
    localStorage.setItem('unrelated-draft', 'preserve this draft');
    localStorage.setItem('sophia-recap', JSON.stringify({ version: 0, state: {
      artifacts: { old: fixture('old') }, decisions: { old: [{ candidateId: 'candidate', decision: 'approved' }] },
      commitStatus: { old: 'committed' },
    } }));
    await useRecapStore.persist.rehydrate();
    expect(useRecapStore.getState().artifacts).toEqual({});
    expect(useRecapStore.getState().decisions).toEqual({});
    expect(useRecapStore.getState().commitStatus).toEqual({});
    expect(JSON.parse(localStorage.getItem('sophia-recap')!).state).toEqual({});
    expect(localStorage.getItem('unrelated-draft')).toBe('preserve this draft');
  });

  it('invalidates only the missing source and its decisions and receipt', () => {
    const store = useRecapStore.getState();
    for (const id of ['deleted', 'preserved']) {
      store.setArtifacts(id, fixture(id));
      store.setDecision(id, 'candidate', 'approved');
    }
    useRecapStore.setState({ commitStatus: { deleted: 'committed', preserved: 'committed' } });
    const preserved = useRecapStore.getState().artifacts.preserved;
    store.invalidateSession('deleted');
    const current = useRecapStore.getState();
    expect(current.artifacts.deleted).toBeUndefined();
    expect(current.decisions.deleted).toBeUndefined();
    expect(current.commitStatus.deleted).toBeUndefined();
    expect(current.artifacts.preserved).toBe(preserved);
    expect(current.decisions.preserved).toHaveLength(1);
    expect(current.commitStatus.preserved).toBe('committed');
  });

  it('drops old revisions and batch completion when fresh authority changes', () => {
    const store = useRecapStore.getState();
    store.setArtifacts('session', fixture('session'));
    store.setDecision('session', 'candidate', 'approved');
    useRecapStore.setState({ commitStatus: { session: 'committed' } });
    store.setArtifacts('session', fixture('session', 2));
    expect(store.getApprovedCandidates('session')).toEqual([]);
    expect(store.allCandidatesReviewed('session')).toBe(false);
    expect(store.getCommitStatus('session')).toBe('idle');
    store.setDecision('session', 'candidate', 'approved');
    store.setArtifacts('session', { ...fixture('session', 2), memoryCandidates: [] });
    expect(store.getDecisions('session')).toEqual([]);
  });

  it('retains only decisions with an explicit unchanged canonical revision', () => {
    const store = useRecapStore.getState();
    store.setArtifacts('session', fixture('session', 3));
    store.setDecision('session', 'candidate', 'approved');
    const decision = store.getDecisions('session')[0];
    store.setArtifacts('session', fixture('session', 3));
    expect(store.getDecisions('session')).toEqual([decision]);
    const legacy = fixture('legacy');
    delete legacy.memoryCandidates[0].candidateRevision;
    store.setArtifacts('legacy', legacy);
    store.setDecision('legacy', 'candidate', 'approved');
    store.setArtifacts('legacy', { ...legacy });
    expect(store.getDecisions('legacy')).toEqual([]);
  });

  it('commits approved memories through the batch bridge', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ committed: ['candidate-1'], discarded: [], errors: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = useRecapStore.getState();
    store.setArtifacts('session-1', {
      sessionId: 'session-1',
      sessionType: 'open',
      contextMode: 'life',
      status: 'ready',
      memoryCandidates: [
        {
          id: 'candidate-1',
          text: 'I recover faster when I pause for breath.',
          category: 'emotional_patterns',
          candidateRevision: 4,
        },
      ],
    });
    store.setDecision('session-1', 'candidate-1', 'approved');

    const result = await useRecapStore.getState().commitMemories('session-1', 'thread-1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/memory/commit-candidates',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      session_id: 'session-1',
      thread_id: 'thread-1',
      decisions: [
        {
          candidate_id: 'candidate-1',
          decision: 'approve',
          text: 'I recover faster when I pause for breath.',
          category: 'emotional_patterns',
          expected_candidate_revision: 4,
          idempotency_key: expect.stringMatching(/^recap:session-1:candidate-1:4:/),
          source: 'recap',
          metadata: {
            session_type: 'open',
            preset: 'life',
          },
        },
      ],
    });
    expect(result).toEqual({ committed: ['candidate-1'], discarded: [], errors: [] });
    expect(useRecapStore.getState().getCommitStatus('session-1')).toBe('committed');
    expect(useRecapStore.getState().getDecisionForCandidate('session-1', 'candidate-1')?.status).toBe('committed');
  });
});

// =============================================================================
// MEM00-C2 WP1 — lost successful response recovery through the command receipt
// =============================================================================

const receiptFixture = {
  event_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  operation_id: 'recap:session-1:candidate-1:4:operation',
  event_type: 'candidate_approved',
  resulting_lifecycle: 'active',
  candidate_id: 'candidate-1',
  user_catalog_generation: 2,
  user_revocation_epoch: 0,
  idempotent_replay: true,
};

const committedStatus = { status: 'committed', historical_result_only: true, receipt: receiptFixture };
const notFoundStatus = { status: 'not_found', historical_result_only: true, receipt: null };

function seedApprovedSession(sessionId: string) {
  const store = useRecapStore.getState();
  store.setArtifacts(sessionId, {
    sessionId, sessionType: 'open', contextMode: 'life', status: 'ready',
    memoryCandidates: [{ id: 'candidate-1', text: 'Synthetic recalled fact', category: 'fact', candidateRevision: 4 }],
  });
  store.setDecision(sessionId, 'candidate-1', 'approved');
}

const postCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => url === '/api/memory/commit-candidates');

describe('MEM00-C2 WP1 lost-response recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useRecapStore.setState({ artifacts: {}, decisions: {}, commitStatus: {} });
  });

  it('recovers the original committed decision without a second mutation', async () => {
    // The commit succeeded upstream but its response could not be joined.
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/memory/commit-candidates') {
        return { ok: true, json: async () => ({ committed: [], discarded: [], errors: [], ambiguous: ['candidate-1'] }) };
      }
      if (url.startsWith('/api/memory/commands/')) {
        return { ok: true, json: async () => committedStatus };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    seedApprovedSession('session-1');

    const result = await useRecapStore.getState().commitMemories('session-1', 'thread-1');

    // Exactly one mutation attempt: recovery reads the receipt, never re-posts.
    expect(postCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/memory/commands/'))).toBe(true);
    expect(result).toMatchObject({ committed: ['candidate-1'], errors: [], ambiguous: [] });
    expect(useRecapStore.getState().getCommitStatus('session-1')).toBe('committed');
    expect(useRecapStore.getState().getDecisionForCandidate('session-1', 'candidate-1')?.status).toBe('committed');
  });

  it('recovers a wholly lost response from the original command key', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/memory/commit-candidates') throw new Error('network transport lost');
      if (url.startsWith('/api/memory/commands/')) {
        return { ok: true, json: async () => committedStatus };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    seedApprovedSession('session-1');

    await expect(useRecapStore.getState().commitMemories('session-1')).rejects.toThrow('network transport lost');

    expect(postCalls(fetchMock)).toHaveLength(1);
    // The historical receipt confirms the original decision landed.
    expect(useRecapStore.getState().getDecisionForCandidate('session-1', 'candidate-1')?.status).toBe('committed');
  });

  it('reports a definite not-committed receipt as an error, not a silent success', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/memory/commit-candidates') {
        return { ok: true, json: async () => ({ committed: [], discarded: [], errors: [], ambiguous: ['candidate-1'] }) };
      }
      if (url.startsWith('/api/memory/commands/')) {
        return { ok: true, json: async () => notFoundStatus };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    seedApprovedSession('session-1');

    const result = await useRecapStore.getState().commitMemories('session-1');

    expect(result).toMatchObject({
      committed: [],
      ambiguous: [],
      errors: [{ candidate_id: 'candidate-1', message: 'review_command_not_committed' }],
    });
    expect(useRecapStore.getState().getCommitStatus('session-1')).toBe('error');
  });

  it('keeps an unreadable receipt ambiguous instead of claiming either outcome', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/memory/commit-candidates') {
        return { ok: true, json: async () => ({ committed: [], discarded: [], errors: [], ambiguous: ['candidate-1'] }) };
      }
      return { ok: false, status: 503, json: async () => ({ available: false }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    seedApprovedSession('session-1');

    const result = await useRecapStore.getState().commitMemories('session-1');

    expect(result).toMatchObject({ committed: [], errors: [], ambiguous: ['candidate-1'] });
    expect(useRecapStore.getState().getCommitStatus('session-1')).toBe('error');
  });
});

