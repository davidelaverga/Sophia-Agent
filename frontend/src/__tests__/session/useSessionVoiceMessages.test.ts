import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionVoiceMessages } from '../../app/session/useSessionVoiceMessages';

type VoiceChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
};

function useVoiceMessagesHarness(setMessageTimestamp: ReturnType<typeof vi.fn>) {
  const [chatMessages, setChatMessages] = useState<VoiceChatMessage[]>([]);
  const voiceMessages = useSessionVoiceMessages({
    setChatMessages,
    setMessageTimestamp,
  });

  return {
    ...voiceMessages,
    chatMessages,
    setMessageTimestamp,
  };
}

describe('useSessionVoiceMessages', () => {
  it('replaces the last voice user message when a paused transcript grows', () => {
    const setMessageTimestamp = vi.fn();
    const { result } = renderHook(() => useVoiceMessagesHarness(setMessageTimestamp));

    act(() => {
      result.current.appendVoiceUserMessage('Good good evening, Sofia.');
    });

    act(() => {
      result.current.appendVoiceUserMessage('Good good evening, Sofia. How are you?');
    });

    act(() => {
      result.current.appendVoiceUserMessage('How are you?');
    });

    expect(result.current.chatMessages).toHaveLength(1);
    expect(result.current.chatMessages[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'Good good evening, Sofia. How are you?' }],
    });
    expect(setMessageTimestamp).toHaveBeenCalledTimes(1);
  });
});