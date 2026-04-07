import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { InterruptPayload } from '../../app/lib/session-types';
import { useSessionVoiceCommandSystem } from '../../app/session/useSessionVoiceCommandSystem';

function buildParams(overrides: Partial<Parameters<typeof useSessionVoiceCommandSystem>[0]> = {}) {
  const onUserTranscript = vi.fn();
  const handleReflectionTap = vi.fn();
  const handleInterruptSelectWithRetry = vi.fn(async () => {});
  const handleInterruptDismiss = vi.fn();
  const handleInterruptSnooze = vi.fn();
  const handleVoiceEndSession = vi.fn(async () => {});
  const showToast = vi.fn();
  const bargeIn = vi.fn();

  const pendingInterrupt: InterruptPayload = {
    kind: 'DEBRIEF_OFFER',
    title: 'Debrief now?',
    message: 'Quick debrief',
    options: [
      { id: 'accept', label: 'Yes', style: 'primary' },
      { id: 'decline', label: 'No', style: 'secondary' },
    ],
    snooze: true,
  };

  const params: Parameters<typeof useSessionVoiceCommandSystem>[0] = {
    onUserTranscript,
    reflectionCandidate: { prompt: 'What did you learn?', why: 'growth' },
    handleReflectionTap,
    pendingInterrupt,
    isResuming: false,
    handleInterruptSelectWithRetry,
    handleInterruptDismiss,
    handleInterruptSnooze,
    isEnding: false,
    isReadOnly: false,
    handleVoiceEndSession,
    voiceState: { bargeIn },
    showToast,
    ...overrides,
  };

  return {
    params,
    onUserTranscript,
    handleReflectionTap,
    handleInterruptSelectWithRetry,
    handleInterruptDismiss,
    handleInterruptSnooze,
    handleVoiceEndSession,
    showToast,
    bargeIn,
  };
}

describe('useSessionVoiceCommandSystem', () => {
  it('routes session end command and suppresses assistant response', () => {
    const {
      params,
      onUserTranscript,
      handleVoiceEndSession,
      showToast,
      bargeIn,
    } = buildParams();

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Sophia end session now');
    });

    expect(handleVoiceEndSession).toHaveBeenCalledTimes(1);
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).toHaveBeenCalledTimes(1);
    expect(result.current.isAssistantResponseSuppressed()).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Ending session by voice command.', variant: 'info' }),
    );
  });

  it('routes interrupt accept command to selected option handler', () => {
    const {
      params,
      onUserTranscript,
      handleInterruptSelectWithRetry,
      bargeIn,
    } = buildParams();

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('sophia yes');
    });

    expect(handleInterruptSelectWithRetry).toHaveBeenCalledWith('accept');
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).toHaveBeenCalledTimes(1);
  });

  it('routes reflection command and forwards candidate with voice-command source', () => {
    const {
      params,
      onUserTranscript,
      handleReflectionTap,
      showToast,
      bargeIn,
    } = buildParams({ pendingInterrupt: null });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('sophia start reflection now');
    });

    expect(handleReflectionTap).toHaveBeenCalledWith(
      { prompt: 'What did you learn?', why: 'growth' },
      'voice-command',
    );
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Reflection activated by voice command.', variant: 'info' }),
    );
  });

  it('normalizes accents/punctuation for spanish reflection command', () => {
    const {
      params,
      onUserTranscript,
      handleReflectionTap,
      showToast,
      bargeIn,
    } = buildParams();

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Sofía, iniciar reflexión ahora!!!');
    });

    expect(handleReflectionTap).toHaveBeenCalledWith(
      { prompt: 'What did you learn?', why: 'growth' },
      'voice-command',
    );
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Reflection activated by voice command.', variant: 'info' }),
    );
  });

  it('falls through to user transcript when text is not a command', () => {
    const {
      params,
      onUserTranscript,
      handleVoiceEndSession,
      handleInterruptSelectWithRetry,
      handleReflectionTap,
    } = buildParams({ pendingInterrupt: null });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('hello there this is normal speech');
    });

    expect(onUserTranscript).toHaveBeenCalledWith('hello there this is normal speech');
    expect(handleVoiceEndSession).not.toHaveBeenCalled();
    expect(handleInterruptSelectWithRetry).not.toHaveBeenCalled();
    expect(handleReflectionTap).not.toHaveBeenCalled();
  });
});
