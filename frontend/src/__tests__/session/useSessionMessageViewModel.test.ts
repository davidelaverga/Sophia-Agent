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

  it('does not render blank assistant messages (tool-call-only turns)', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Hey Sophia!' }] },
          { id: 'a-blank', role: 'assistant', parts: [{ type: 'text', text: '   ' }] },
          { id: 'a-empty', role: 'assistant', parts: [] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.messages.map((message) => message.id)).toEqual(['u-1']);
  });

  it('renders adjacent equivalent assistant replies once, including curly apostrophe variants', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
          { id: 'a-stream', role: 'assistant', parts: [{ type: 'text', text: "Starting the build now — I'll have it back to you shortly." }] },
          { id: 'a-backfill', role: 'assistant', parts: [{ type: 'text', text: 'Starting the build now — I’ll have it back to you shortly.' }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.messages.map((message) => message.id)).toEqual(['u-1', 'a-stream']);
    expect(result.current.latestAssistantMessage?.id).toBe('a-stream');
  });

  it('keeps genuinely different adjacent assistant replies separate', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
          { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'Starting the build now.' }] },
          { id: 'a-2', role: 'assistant', parts: [{ type: 'text', text: 'Your page is ready — take a look!' }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.messages.map((message) => message.id)).toEqual(['u-1', 'a-1', 'a-2']);
  });

  it('preserves an identical reply when a user turn sits between the copies', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'How are you?' }] },
          { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'Right here with you, always.' }] },
          { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'Say that again?' }] },
          { id: 'a-2', role: 'assistant', parts: [{ type: 'text', text: 'Right here with you, always.' }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.messages.map((message) => message.id)).toEqual(['u-1', 'a-1', 'u-2', 'a-2']);
  });

  it('keeps the more complete text when a duplicate carries more content', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
          { id: 'a-short', role: 'assistant', parts: [{ type: 'text', text: "Starting the build now — I'll have it back to you shortly." }] },
          { id: 'a-long', role: 'assistant', parts: [{ type: 'text', text: "Starting the build now — I'll have it back to you shortly. It should only take a few minutes." }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.messages.map((message) => message.id)).toEqual(['u-1', 'a-short']);
    expect(result.current.messages[1].content).toContain('only take a few minutes');
  });

  it('suppresses duplicate message ids while preserving the first position with the most complete content', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
          { id: 'a-dup', role: 'assistant', parts: [{ type: 'text', text: '' }] },
          { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'follow up' }] },
          { id: 'a-dup', role: 'assistant', parts: [{ type: 'text', text: 'complete assistant reply' }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.messages.map((message) => message.id)).toEqual(['u-1', 'a-dup', 'u-2']);
    expect(result.current.messages[1]).toMatchObject({
      id: 'a-dup',
      role: 'assistant',
      content: 'complete assistant reply',
    });
  });
});
