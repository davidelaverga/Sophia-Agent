import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionChatInitialization } from '../../app/session/useSessionChatInitialization';
import type { SessionClientStore, SessionMessage } from '../../app/types/session';

const session: SessionClientStore = {
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
};

function renderInitialization(storedMessages: SessionMessage[]) {
  const setChatMessages = vi.fn();
  const setMessageTimestamp = vi.fn();

  const hook = renderHook(
    ({ messages }) =>
      useSessionChatInitialization({
        session,
        storedMessages: messages,
        initialGreeting: 'I am here.',
        greetingMessageId: 'greeting-1',
        hasBootstrap: false,
        bootstrap: null,
        greetingRendered: false,
        markGreetingRendered: vi.fn(),
        memoryHighlights: [],
        sessionPresetType: 'open',
        sessionContextMode: 'life',
        setChatMessages,
        setLastUserMessageId: vi.fn(),
        setLastUserMessageContent: vi.fn(),
        setCancelledMessageId: vi.fn(),
        setIsInterruptedByRefresh: vi.fn(),
        setInterruptedResponseMode: vi.fn(),
        setRefreshInterruptedAt: vi.fn(),
        hasShownReconnectRef: { current: false },
        setMessageTimestamp,
        showToast: vi.fn(),
      }),
    { initialProps: { messages: storedMessages } },
  );

  return { ...hook, setChatMessages, setMessageTimestamp };
}

describe('useSessionChatInitialization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('lets restored transcript messages replace the delayed fallback greeting', async () => {
    const { rerender, setChatMessages } = renderInitialization([]);

    expect(setChatMessages).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(setChatMessages).toHaveBeenCalledWith([
      {
        id: 'greeting-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'I am here.' }],
      },
    ]);

    setChatMessages.mockClear();
    rerender({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'past session message',
          createdAt: '2026-04-15T00:01:00.000Z',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'past Sophia reply',
          createdAt: '2026-04-15T00:01:05.000Z',
        },
      ],
    });

    expect(setChatMessages).toHaveBeenCalledWith([
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'past session message' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'past Sophia reply' }],
      },
    ]);
  });
});
