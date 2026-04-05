import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionCancelledRetryVoiceReplay } from '../../app/session/useSessionCancelledRetryVoiceReplay';

describe('useSessionCancelledRetryVoiceReplay', () => {
  it('exposes a sync press callback that triggers retry flow', async () => {
    const handleRetry = vi.fn(async () => ({ kind: 'recovered' as const, response: 'Recovered answer' }));
    const speakText = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useSessionCancelledRetryVoiceReplay({
        interruptedResponseMode: 'voice',
        sessionVoiceMode: false,
        latestAssistantMessage: { id: 'a1', content: 'old' },
        isTyping: false,
        handleRetry,
        speakText,
      }),
    );

    await act(async () => {
      result.current.handleCancelledRetryPress();
    });

    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('speaks recovered response immediately in voice mode', async () => {
    const handleRetry = vi.fn(async () => ({ kind: 'recovered' as const, response: 'Recovered answer' }));
    const speakText = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useSessionCancelledRetryVoiceReplay({
        interruptedResponseMode: 'voice',
        sessionVoiceMode: false,
        latestAssistantMessage: { id: 'a1', content: 'old' },
        isTyping: false,
        handleRetry,
        speakText,
      }),
    );

    await act(async () => {
      await result.current.handleCancelledRetry();
    });

    expect(handleRetry).toHaveBeenCalledTimes(1);
    expect(speakText).toHaveBeenCalledWith('Recovered answer');
  });

  it('replays resent response after assistant message changes', async () => {
    const handleRetry = vi.fn(async () => ({ kind: 'resent' as const }));
    const speakText = vi.fn(async () => {});

    const { result, rerender } = renderHook(
      ({ latestAssistantMessage, isTyping }) =>
        useSessionCancelledRetryVoiceReplay({
          interruptedResponseMode: 'voice',
          sessionVoiceMode: false,
          latestAssistantMessage,
          isTyping,
          handleRetry,
          speakText,
        }),
      {
        initialProps: {
          latestAssistantMessage: { id: 'a1', content: 'old' },
          isTyping: false,
        },
      },
    );

    await act(async () => {
      await result.current.handleCancelledRetry();
    });

    expect(speakText).not.toHaveBeenCalled();

    rerender({ latestAssistantMessage: { id: 'a2', content: 'new response' }, isTyping: false });

    expect(speakText).toHaveBeenCalledWith('new response');
  });
});
