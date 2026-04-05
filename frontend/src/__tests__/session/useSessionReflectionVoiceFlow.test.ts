import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SESSION_REFLECTION_PREFIX, useSessionReflectionVoiceFlow } from '../../app/session/useSessionReflectionVoiceFlow';

describe('useSessionReflectionVoiceFlow', () => {
  it('queues reflection user message locally when offline', () => {
    type ChatMessage = {
      id: string;
      role: 'system' | 'user' | 'assistant';
      parts: Array<{ type?: string; text?: string; [key: string]: unknown }>;
    };

    const queueMessage = vi.fn(() => 'q-1');
    const setChatMessages = vi.fn((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      const next = updater([]);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({
        id: 'queued-q-1',
        role: 'user',
      });
      expect(next[0].parts[0]).toMatchObject({
        type: 'text',
        text: `${SESSION_REFLECTION_PREFIX}What did I learn today?`,
      });
    });
    const showToast = vi.fn();
    const sendMessage = vi.fn(async () => undefined);
    const speakText = vi.fn(async () => true);

    const { result } = renderHook(() =>
      useSessionReflectionVoiceFlow({
        reflectionPrefix: SESSION_REFLECTION_PREFIX,
        messages: [],
        isStreaming: false,
        chatStatus: 'ready',
        isTyping: false,
        voiceStatus: 'ready',
        isReflectionTtsActive: false,
        speakText,
        sendMessage,
        connectivityStatus: 'offline',
        queueMessage,
        sessionId: 'session-1',
        setChatMessages,
        showToast,
      })
    );

    act(() => {
      result.current.handleReflectionTap({ prompt: 'What did I learn today?' }, 'tap');
    });

    expect(queueMessage).toHaveBeenCalledWith(`${SESSION_REFLECTION_PREFIX}What did I learn today?`, 'session-1');
    expect(setChatMessages).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'info' })
    );
  });
});
