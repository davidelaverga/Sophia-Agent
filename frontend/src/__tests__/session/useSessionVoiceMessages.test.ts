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

  it('replaces the last voice assistant message as a transcript grows', () => {
    const setMessageTimestamp = vi.fn();
    const { result } = renderHook(() => useVoiceMessagesHarness(setMessageTimestamp));

    act(() => {
      result.current.appendVoiceAssistantMessage('That sounds heavy.', false);
    });

    act(() => {
      result.current.appendVoiceAssistantMessage('That sounds heavy. I am here with you.', false);
    });

    act(() => {
      result.current.appendVoiceAssistantMessage('That sounds heavy. I am here with you.', false);
    });

    expect(result.current.chatMessages).toHaveLength(1);
    expect(result.current.chatMessages[0]).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: 'That sounds heavy. I am here with you.' }],
    });
    expect(setMessageTimestamp).toHaveBeenCalledTimes(1);
  });

  it('does not append cumulative assistant snapshots into one corrupted message', () => {
    const setMessageTimestamp = vi.fn();
    const { result } = renderHook(() => useVoiceMessagesHarness(setMessageTimestamp));

    act(() => {
      result.current.appendVoiceAssistantMessage('Yeah, I hear', false);
    });

    act(() => {
      result.current.appendVoiceAssistantMessage('Yeah, I hear you.', false);
    });

    act(() => {
      result.current.appendVoiceAssistantMessage('Yeah, I can hear you fine.', false);
    });

    expect(result.current.chatMessages).toHaveLength(1);
    expect(result.current.chatMessages[0]).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: 'Yeah, I can hear you fine.' }],
    });
    expect(JSON.stringify(result.current.chatMessages)).not.toContain('hearYeah');
    expect(setMessageTimestamp).toHaveBeenCalledTimes(1);
  });
});