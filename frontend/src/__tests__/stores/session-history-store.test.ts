import { beforeEach, describe, expect, it } from 'vitest';

import { useSessionHistoryStore } from '../../app/stores/session-history-store';

describe('session-history-store syncSessions', () => {
  beforeEach(() => {
    useSessionHistoryStore.getState().clearHistory();
    localStorage.clear();
  });

  it('preserves review flags for sessions returned by backend sync', () => {
    const store = useSessionHistoryStore.getState();

    store.addSession({
      sessionId: 'ended-1',
      presetType: 'debrief',
      contextMode: 'work',
      startedAt: '2026-04-20T10:00:00Z',
      endedAt: '2026-04-20T10:30:00Z',
      messageCount: 4,
      takeawayPreview: 'Recap 1',
    });
    store.markRecapViewed('ended-1');
    store.markMemoriesApproved('ended-1');

    store.syncSessions([
      {
        sessionId: 'ended-1',
        presetType: 'debrief',
        contextMode: 'work',
        startedAt: '2026-04-20T10:00:00Z',
        endedAt: '2026-04-20T10:30:00Z',
        messageCount: 5,
        takeawayPreview: 'Recap 1 updated',
      },
    ]);

    const synced = useSessionHistoryStore.getState().getSession('ended-1');
    expect(synced).toMatchObject({
      sessionId: 'ended-1',
      recapViewed: true,
      memoriesApproved: true,
      messageCount: 5,
      takeawayPreview: 'Recap 1 updated',
    });
  });

  it('drops stale local-only sessions after successful backend sync', () => {
    const store = useSessionHistoryStore.getState();

    store.addSession({
      sessionId: 'local-old',
      presetType: 'open',
      contextMode: 'life',
      startedAt: '2026-04-18T09:00:00Z',
      endedAt: '2026-04-18T09:10:00Z',
      messageCount: 2,
      takeawayPreview: 'Should disappear',
    });

    store.syncSessions([
      {
        sessionId: 'server-new',
        presetType: 'prepare',
        contextMode: 'work',
        startedAt: '2026-04-21T12:00:00Z',
        endedAt: '2026-04-21T12:20:00Z',
        messageCount: 6,
        takeawayPreview: 'Server source of truth',
      },
    ]);

    const sessions = useSessionHistoryStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('server-new');
    expect(useSessionHistoryStore.getState().getSession('local-old')).toBeUndefined();
  });
});
