import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/hooks/usePlatformSignal', () => ({
  usePlatformSignal: () => 'text',
}));

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  authBypassEnabled: true,
  authBypassUserId: 'dev-user',
}));

import { useSessionPageContext } from '../../app/session/useSessionPageContext';
import { useMessageMetadataStore } from '../../app/stores/message-metadata-store';
import { useSessionStore } from '../../app/stores/session-store';

describe('useSessionPageContext', () => {
  beforeEach(() => {
    useSessionStore.setState({
      session: null,
      isInitializing: false,
      isEnding: false,
      error: null,
    });
    useMessageMetadataStore.setState({
      metadataByMessage: {},
      currentThreadId: null,
      currentSessionId: null,
      currentRunId: null,
      emotionalWeather: null,
    });
  });

  it('prefers the freshest matching thread id for ritual text requests', () => {
    useSessionStore.setState({
      session: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        threadId: 'thread-stale',
        userId: 'dev-user',
        presetType: 'prepare',
        contextMode: 'life',
        status: 'active',
        voiceMode: false,
        startedAt: '2026-03-03T19:46:00.000Z',
        lastActivityAt: '2026-03-03T19:46:00.000Z',
        activeElapsedSeconds: 0,
        activeSegmentStartedAt: '2026-03-03T19:46:00.000Z',
        isActive: true,
        companionInvokesCount: 0,
      },
      isInitializing: false,
      isEnding: false,
      error: null,
    });

    useMessageMetadataStore.setState({
      metadataByMessage: {},
      currentThreadId: 'thread-fresh',
      currentSessionId: '550e8400-e29b-41d4-a716-446655440000',
      currentRunId: null,
      emotionalWeather: null,
    });

    const { result } = renderHook(() =>
      useSessionPageContext({
        bootstrapSessionId: undefined,
        bootstrapMessageId: undefined,
        bootstrapMemoryHighlights: undefined,
      }),
    );

    expect(result.current.resolvedThreadId).toBe('thread-fresh');
    expect(result.current.chatRequestBody).toEqual(
      expect.objectContaining({
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        thread_id: 'thread-fresh',
      }),
    );
    expect(useSessionStore.getState().session?.threadId).toBe('thread-fresh');
  });
});