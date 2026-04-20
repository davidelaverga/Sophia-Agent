import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updatePersistedSessionMock = vi.fn();

vi.mock('../../app/lib/api/sessions-api', () => ({
  deleteSessionRecord: vi.fn(),
  endSession: vi.fn(),
  getOpenSessions: vi.fn(async () => ({ success: true, data: { sessions: [], count: 0 } })),
  getSession: vi.fn(async () => ({ success: false, error: 'missing', code: 'NOT_FOUND' })),
  listSessions: vi.fn(async () => ({ success: true, data: { sessions: [], total: 0 } })),
  updateSession: (...args: unknown[]) => updatePersistedSessionMock(...args),
  isError: (result: { success: boolean }) => !result.success,
}));

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
    updatePersistedSessionMock.mockReset();
    updatePersistedSessionMock.mockImplementation(async (sessionId: string, updates: { status?: 'open' | 'paused' }) => ({
      success: true,
      data: {
        session_id: sessionId,
        thread_id: 'thread-synced',
        session_type: 'prepare',
        preset_context: 'life',
        status: updates.status ?? 'open',
        started_at: '2026-03-03T19:46:00.000Z',
        updated_at: '2026-03-03T19:47:00.000Z',
        ended_at: null,
        turn_count: 0,
        title: null,
        last_message_preview: null,
        platform: 'text',
        intention: null,
        focus_cue: null,
      },
    }));

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

  it('syncs paused sessions back to open without overwriting the persisted backend thread id', async () => {
    useSessionStore.setState({
      session: {
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
        threadId: 'thread-paused',
        userId: 'dev-user',
        presetType: 'prepare',
        contextMode: 'life',
        status: 'paused',
        voiceMode: false,
        startedAt: '2026-03-03T19:46:00.000Z',
        lastActivityAt: '2026-03-03T19:46:00.000Z',
        activeElapsedSeconds: 0,
        isActive: true,
        companionInvokesCount: 0,
      },
      isInitializing: false,
      isEnding: false,
      error: null,
    });

    useMessageMetadataStore.setState({
      metadataByMessage: {},
      currentThreadId: '550e8400-e29b-41d4-a716-446655440001',
      currentSessionId: '550e8400-e29b-41d4-a716-446655440001',
      currentRunId: null,
      emotionalWeather: null,
    });

    const { result, unmount } = renderHook(() =>
      useSessionPageContext({
        bootstrapSessionId: undefined,
        bootstrapMessageId: undefined,
        bootstrapMemoryHighlights: undefined,
      }),
    );

    await waitFor(() => {
      expect(updatePersistedSessionMock).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440001',
        { status: 'open' },
        'dev-user',
      );
    });

    expect(result.current.resolvedThreadId).toBe('thread-paused');
    expect(useSessionStore.getState().session?.threadId).toBe('thread-paused');

    expect(useSessionStore.getState().session).toMatchObject({
      status: 'active',
      isActive: true,
    });

    unmount();

    await waitFor(() => {
      expect(updatePersistedSessionMock).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440001',
        { status: 'paused' },
        'dev-user',
      );
    });

    expect(useSessionStore.getState().session?.threadId).toBe('thread-paused');

    expect(useSessionStore.getState().session).toMatchObject({
      status: 'paused',
      isActive: true,
    });
  });

  it('does not mark paused sessions as read-only even if isActive was persisted false', async () => {
    useSessionStore.setState({
      session: {
        sessionId: '550e8400-e29b-41d4-a716-446655440002',
        threadId: 'thread-paused-stale',
        userId: 'dev-user',
        presetType: 'prepare',
        contextMode: 'life',
        status: 'paused',
        voiceMode: false,
        startedAt: '2026-03-03T19:46:00.000Z',
        lastActivityAt: '2026-03-03T19:46:00.000Z',
        activeElapsedSeconds: 0,
        isActive: false,
        companionInvokesCount: 0,
      },
      isInitializing: false,
      isEnding: false,
      error: null,
    });

    const { result } = renderHook(() =>
      useSessionPageContext({
        bootstrapSessionId: undefined,
        bootstrapMessageId: undefined,
        bootstrapMemoryHighlights: undefined,
      }),
    );

    expect(result.current.isReadOnly).toBe(false);
  });
});