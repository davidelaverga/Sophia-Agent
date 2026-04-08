import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionUiCallbacks } from '../../app/session/useSessionUiCallbacks';

describe('useSessionUiCallbacks', () => {
  const baseDeps = () => ({
    setFeedback: vi.fn(),
    setShowFeedbackToast: vi.fn(),
    setDismissedError: vi.fn(),
    setInput: vi.fn(),
    focusComposer: vi.fn(),
    sendMessage: vi.fn(),
    navigateHome: vi.fn(),
    clearSessionError: vi.fn(),
    endSession: vi.fn(),
    takeOverSession: vi.fn(),
  });

  it('handles prompt selection by updating input and focusing composer', () => {
    const deps = baseDeps();

    const { result } = renderHook(() => useSessionUiCallbacks({
      ...deps,
      messages: [],
    }));

    act(() => {
      result.current.handlePromptSelect('Try this prompt');
    });

    expect(deps.setInput).toHaveBeenCalledWith('Try this prompt');
    expect(deps.focusComposer).toHaveBeenCalledTimes(1);
  });

  it('dismisses stream error via hook-owned callback', () => {
    const deps = baseDeps();

    const { result } = renderHook(() => useSessionUiCallbacks({
      ...deps,
      messages: [],
    }));

    act(() => {
      result.current.handleDismissStreamError();
    });

    expect(deps.setDismissedError).toHaveBeenCalledWith(true);
  });

  it('retries stream error using last user message', () => {
    const deps = baseDeps();

    const { result } = renderHook(() => useSessionUiCallbacks({
      ...deps,
      messages: [
        { id: 'a1', role: 'assistant', content: 'hello', createdAt: '2026-03-02T00:00:00.000Z' },
        { id: 'u1', role: 'user', content: 'retry me', createdAt: '2026-03-02T00:00:01.000Z' },
      ],
    }));

    act(() => {
      result.current.handleStreamErrorRetry();
    });

    expect(deps.setDismissedError).toHaveBeenCalledWith(true);
    expect(deps.sendMessage).toHaveBeenCalledWith({ text: 'retry me' });
  });

  it('handles session-expired retry by clearing error, ending session, and navigating home', () => {
    const deps = baseDeps();

    const { result } = renderHook(() => useSessionUiCallbacks({
      ...deps,
      messages: [],
    }));

    act(() => {
      result.current.handleSessionExpiredRetry();
    });

    expect(deps.clearSessionError).toHaveBeenCalledTimes(1);
    expect(deps.endSession).toHaveBeenCalledTimes(1);
    expect(deps.navigateHome).toHaveBeenCalledTimes(1);
  });

  it('handles multi-tab callbacks through hook-owned actions', () => {
    const deps = baseDeps();

    const { result } = renderHook(() => useSessionUiCallbacks({
      ...deps,
      messages: [],
    }));

    act(() => {
      result.current.handleMultiTabGoHome();
      result.current.handleMultiTabTakeOver();
    });

    expect(deps.clearSessionError).toHaveBeenCalledTimes(1);
    expect(deps.navigateHome).toHaveBeenCalledTimes(1);
    expect(deps.takeOverSession).toHaveBeenCalledTimes(1);
  });
});
