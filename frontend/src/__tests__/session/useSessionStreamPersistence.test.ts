import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStreamPersistence } from '../../app/session/useSessionStreamPersistence';
import { useSessionStore } from '../../app/stores/session-store';

const { persistSessionMessagesMock } = vi.hoisted(() => ({
  persistSessionMessagesMock: vi.fn(),
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  isError: (value: { success?: boolean }) => value?.success === false,
  persistSessionMessages: (...args: unknown[]) => persistSessionMessagesMock(...args),
}));

vi.mock('../../app/lib/debug-logger', () => ({
  debugLog: vi.fn(),
}));

describe('useSessionStreamPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistSessionMessagesMock.mockReset();
    persistSessionMessagesMock.mockResolvedValue({
      success: true,
      data: { session_id: '11111111-1111-4111-8111-111111111111', thread_id: 'thread-1', messages: [] },
    });
    useSessionStore.setState({
      session: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        threadId: 'thread-1',
        userId: 'user-1',
        presetType: 'open',
        contextMode: 'life',
        status: 'active',
        voiceMode: false,
        startedAt: '2026-04-15T00:00:00.000Z',
        lastActivityAt: '2026-04-15T00:00:00.000Z',
        isActive: true,
        companionInvokesCount: 0,
      },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    useSessionStore.getState().clearSession();
  });

  it('persists through updateMessages without direct localStorage writes', () => {
    const updateMessages = vi.fn();
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem');

    const { unmount } = renderHook(() =>
      useSessionStreamPersistence({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'hello',
            createdAt: new Date().toISOString(),
          },
        ],
        chatStatus: 'streaming',
        updateMessages,
      })
    );

    expect(updateMessages).toHaveBeenCalledTimes(1);
    expect(setItemSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('syncs an ordered transcript snapshot to the backend session', async () => {
    const updateMessages = vi.fn();

    renderHook(() =>
      useSessionStreamPersistence({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'restore this later',
            createdAt: '2026-04-15T00:01:00.000Z',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I will keep the thread warm.',
            createdAt: '2026-04-15T00:01:05.000Z',
          },
        ],
        chatStatus: 'ready',
        updateMessages,
      })
    );

    await vi.advanceTimersByTimeAsync(200);

    expect(persistSessionMessagesMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      {
        user_id: 'user-1',
        thread_id: 'thread-1',
        messages: [
          {
            id: 'user-1',
            message_id: 'user-1',
            role: 'user',
            content: 'restore this later',
            created_at: '2026-04-15T00:01:00.000Z',
            source: 'text',
            final: true,
            incomplete: false,
          },
          {
            id: 'assistant-1',
            message_id: 'assistant-1',
            role: 'assistant',
            content: 'I will keep the thread warm.',
            created_at: '2026-04-15T00:01:05.000Z',
            source: 'text',
            final: true,
            incomplete: false,
          },
        ],
      },
      'user-1',
    );
  });

  it('does not persist a UI-only fallback greeting', async () => {
    const updateMessages = vi.fn();

    useSessionStore.setState((state) => ({
      session: state.session
        ? {
            ...state.session,
            greetingMessageId: 'greeting-1',
          }
        : state.session,
    }));

    renderHook(() =>
      useSessionStreamPersistence({
        messages: [
          {
            id: 'greeting-1',
            role: 'assistant',
            content: "I'm here with you. What's on your mind?",
            createdAt: '2026-04-15T00:00:00.000Z',
          },
        ],
        chatStatus: 'ready',
        updateMessages,
      })
    );

    await vi.advanceTimersByTimeAsync(200);

    expect(persistSessionMessagesMock).not.toHaveBeenCalled();
  });

  it('persists only finalized visible messages while an assistant response is streaming', async () => {
    const updateMessages = vi.fn();

    renderHook(() =>
      useSessionStreamPersistence({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'Can you repeat that?',
            createdAt: '2026-04-15T00:01:00.000Z',
          },
          {
            id: 'assistant-streaming',
            role: 'assistant',
            content: 'Of co',
            createdAt: '2026-04-15T00:01:03.000Z',
          },
        ],
        chatStatus: 'streaming',
        updateMessages,
      })
    );

    await vi.advanceTimersByTimeAsync(800);

    expect(persistSessionMessagesMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      {
        user_id: 'user-1',
        thread_id: 'thread-1',
        messages: [
          {
            id: 'user-1',
            message_id: 'user-1',
            role: 'user',
            content: 'Can you repeat that?',
            created_at: '2026-04-15T00:01:00.000Z',
            source: 'text',
            final: true,
            incomplete: false,
          },
        ],
      },
      'user-1',
    );
  });

  it('uses stable message ids across repeated transcript persistence calls', async () => {
    const updateMessages = vi.fn();
    const messages = [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'green harbor notebook',
        createdAt: '2026-04-15T00:01:00.000Z',
      },
    ];

    const { rerender } = renderHook(
      ({ nextMessages }) =>
        useSessionStreamPersistence({
          messages: nextMessages,
          chatStatus: 'ready',
          updateMessages,
        }),
      { initialProps: { nextMessages: messages } },
    );

    await vi.advanceTimersByTimeAsync(200);
    rerender({ nextMessages: [...messages] });
    await vi.advanceTimersByTimeAsync(200);

    const firstPayload = persistSessionMessagesMock.mock.calls[0]?.[1] as { messages: Array<{ message_id: string }> };
    const secondPayload = persistSessionMessagesMock.mock.calls[1]?.[1] as { messages: Array<{ message_id: string }> };
    expect(firstPayload.messages[0].message_id).toBe('user-1');
    expect(secondPayload.messages[0].message_id).toBe('user-1');
  });
});
