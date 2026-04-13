import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionMessageViewModel } from '../../app/session/useSessionMessageViewModel';

describe('useSessionMessageViewModel', () => {
  it('exposes latest assistant message derived from mapped UI messages', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
          { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'first reply' }] },
          { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'follow up' }] },
          { id: 'a-2', role: 'assistant', parts: [{ type: 'text', text: 'latest reply' }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.latestAssistantMessage).toEqual({
      id: 'a-2',
      content: 'latest reply',
    });
  });

  it('collapses overlapping consecutive voice user transcripts into one visible message', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'voice-user-1', role: 'user', parts: [{ type: 'text', text: 'Good good evening, Sofia.' }] },
          { id: 'voice-user-2', role: 'user', parts: [{ type: 'text', text: 'Good good evening, Sofia. How are you?' }] },
          { id: 'voice-user-3', role: 'user', parts: [{ type: 'text', text: 'How are you?' }] },
          { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'I am doing well.' }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({
      id: 'voice-user-1',
      content: 'Good good evening, Sofia. How are you?',
      voiceTranscript: true,
    });
  });
});
