import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: vi.fn(),
  },
}));

import { useRecapStore } from '../../app/stores/recap-store';

describe('Recap Store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useRecapStore.setState({
      artifacts: {},
      decisions: {},
      commitStatus: {},
    });
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