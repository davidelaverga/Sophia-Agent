import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const touchSessionMock = vi.fn();

vi.mock('../../app/lib/api/sessions-api', () => ({
  touchSession: (...args: unknown[]) => touchSessionMock(...args),
  isError: (result: { success: boolean }) => !result.success,
}));

vi.mock('../../app/lib/debug-logger', () => ({
  debugLog: vi.fn(),
}));

import { useSessionOutboundSend } from '../../app/session/useSessionSendActions';
import { useSessionStore } from '../../app/stores/session-store';

describe('useSessionOutboundSend', () => {
  beforeEach(() => {
    touchSessionMock.mockReset();
    touchSessionMock.mockResolvedValue({
      success: true,
      data: {
        session_id: 'sess-1',
        thread_id: 'thread-1',
        session_type: 'open',
        preset_context: 'life',
        status: 'open',
        started_at: '2026-04-15T00:00:00.000Z',
        updated_at: '2026-04-15T00:01:00.000Z',
        ended_at: null,
        turn_count: 1,
        title: 'Preparing for my investor meeting tomorrow',
        last_message_preview: 'I need to prepare for my investor meeting tomorrow',
        platform: 'text',
        intention: null,
        focus_cue: null,
      },
    });
    localStorage.clear();
    useSessionStore.setState({
      session: null,
      openSessions: [],
      recentSessions: [],
      isLoadingSessions: false,
      lastOpenSessionsFetchAt: null,
      isInitializing: false,
      isEnding: false,
      error: null,
    });
  });

  it('updates the open-session descriptor after a successful send', async () => {
    const sendChatMessage = vi.fn(async () => undefined);

    useSessionStore.setState({
      session: {
        sessionId: 'sess-1',
        threadId: 'thread-1',
        userId: 'dev-user',
        presetType: 'open',
        contextMode: 'life',
        status: 'active',
        voiceMode: false,
        startedAt: '2026-04-15T00:00:00.000Z',
        lastActivityAt: '2026-04-15T00:00:00.000Z',
        isActive: true,
        companionInvokesCount: 0,
      },
      openSessions: [
        {
          session_id: 'sess-1',
          thread_id: 'thread-1',
          session_type: 'open',
          preset_context: 'life',
          status: 'open',
          started_at: '2026-04-15T00:00:00.000Z',
          updated_at: '2026-04-15T00:00:00.000Z',
          turn_count: 0,
          title: null,
          last_message_preview: null,
        },
      ],
    });

    const { result } = renderHook(() => useSessionOutboundSend({
      chatStatus: 'ready',
      sendChatMessage,
      hasValidBackendSessionId: true,
      chatRequestBody: {
        session_id: 'sess-1',
        user_id: 'dev-user',
      },
      debugEnabled: false,
      markStreamTurnStarted: vi.fn(),
      showToast: vi.fn(),
    }));

    await act(async () => {
      await result.current({ text: 'I need to prepare for my investor meeting tomorrow' });
    });

    expect(sendChatMessage).toHaveBeenCalledWith(
      { text: 'I need to prepare for my investor meeting tomorrow' },
      { body: { session_id: 'sess-1', user_id: 'dev-user' } },
    );
    expect(touchSessionMock).toHaveBeenCalledWith(
      'sess-1',
      'dev-user',
      'I need to prepare for my investor meeting tomorrow',
    );

    const session = useSessionStore.getState().openSessions[0];
    expect(session.title).toBe('Preparing for my investor meeting tomorrow');
    expect(session.last_message_preview).toBe('I need to prepare for my investor meeting tomorrow');
    expect(session.turn_count).toBe(1);
  });
});