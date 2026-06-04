import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactReviewVoiceCommandRouteResult } from '../../app/lib/artifact-review-voice-commands';
import type { InterruptPayload } from '../../app/lib/session-types';
import {
  clearSessionLeaveGuardAnnotationSuppressionForTests,
  isSessionLeaveGuardSuppressedForAnnotation,
} from '../../app/session/session-annotation-navigation-guard';
import { useSessionVoiceCommandSystem } from '../../app/session/useSessionVoiceCommandSystem';

function buildParams(overrides: Partial<Parameters<typeof useSessionVoiceCommandSystem>[0]> = {}) {
  const onUserTranscript = vi.fn();
  const handleReflectionTap = vi.fn();
  const handleDownloadBuilderArtifact = vi.fn(() => true);
  const handleInterruptSelectWithRetry = vi.fn(async () => {});
  const handleInterruptDismiss = vi.fn();
  const handleInterruptSnooze = vi.fn();
  const handleVoiceEndSession = vi.fn(async () => {});
  const showToast = vi.fn();
  const bargeIn = vi.fn();
  const softBargeIn = vi.fn();

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
    canDownloadBuilderArtifact: false,
    handleDownloadBuilderArtifact,
    pendingInterrupt,
    isResuming: false,
    handleInterruptSelectWithRetry,
    handleInterruptDismiss,
    handleInterruptSnooze,
    isEnding: false,
    isReadOnly: false,
    handleVoiceEndSession,
    voiceState: { bargeIn, softBargeIn },
    showToast,
    ...overrides,
  };

  return {
    params,
    onUserTranscript,
    handleReflectionTap,
    handleDownloadBuilderArtifact,
    handleInterruptSelectWithRetry,
    handleInterruptDismiss,
    handleInterruptSnooze,
    handleVoiceEndSession,
    showToast,
    bargeIn,
    softBargeIn,
  };
}

describe('useSessionVoiceCommandSystem', () => {
  afterEach(() => {
    clearSessionLeaveGuardAnnotationSuppressionForTests();
  });

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

  it('keeps the explicit leave-session command routed to session exit', () => {
    const {
      params,
      onUserTranscript,
      handleVoiceEndSession,
      bargeIn,
    } = buildParams();

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Sophia leave the session');
    });

    expect(handleVoiceEndSession).toHaveBeenCalledTimes(1);
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).toHaveBeenCalledTimes(1);
  });

  it('keeps go back routed to session exit outside annotation context', () => {
    const {
      params,
      onUserTranscript,
      handleVoiceEndSession,
      bargeIn,
    } = buildParams();

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Sophia go back');
    });

    expect(handleVoiceEndSession).toHaveBeenCalledTimes(1);
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).toHaveBeenCalledTimes(1);
  });

  it('routes interrupt accept command to selected option handler', () => {
    const {
      params,
      onUserTranscript,
      handleInterruptSelectWithRetry,
      softBargeIn,
    } = buildParams();

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('sophia yes');
    });

    expect(handleInterruptSelectWithRetry).toHaveBeenCalledWith('accept');
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(softBargeIn).toHaveBeenCalledTimes(1);
  });

  it('routes reflection command and forwards candidate with voice-command source', () => {
    const {
      params,
      onUserTranscript,
      handleReflectionTap,
      showToast,
      softBargeIn,
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
    expect(softBargeIn).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Reflection activated by voice command.', variant: 'info' }),
    );
  });

  it('routes bare download command when a builder deliverable is ready', () => {
    const {
      params,
      onUserTranscript,
      handleDownloadBuilderArtifact,
      showToast,
      softBargeIn,
    } = buildParams({
      pendingInterrupt: null,
      canDownloadBuilderArtifact: true,
    });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('download now');
    });

    expect(handleDownloadBuilderArtifact).toHaveBeenCalledTimes(1);
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(softBargeIn).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Downloading deliverable.', variant: 'success' }),
    );
  });

  it('routes artifact review commands without appending them as normal transcripts', () => {
    const {
      params,
      onUserTranscript,
      showToast,
      bargeIn,
      softBargeIn,
    } = buildParams({
      pendingInterrupt: null,
      routeArtifactReviewCommand: vi.fn(() => ({
        handled: true,
        command: { kind: 'go_to_page', pageTarget: 2 },
        applied: true,
        blockedReason: null,
        triggeredRefresh: true,
        refreshResult: 'pending',
        userMessage: null,
      } satisfies ArtifactReviewVoiceCommandRouteResult)),
    });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Go to page two in your analysis.');
    });

    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).not.toHaveBeenCalled();
    expect(softBargeIn).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('routes leave-a-comment phrasing as annotation without ending the session', () => {
    const routeArtifactReviewCommand = vi.fn(() => ({
      handled: true,
      command: {
        kind: 'add_annotation',
        annotationKind: 'comment',
        commentText: 'change the font',
        utteranceKind: 'annotation_comment',
      },
      applied: true,
      blockedReason: null,
      triggeredRefresh: false,
      refreshResult: 'not_requested',
      userMessage: null,
    } satisfies ArtifactReviewVoiceCommandRouteResult));
    const {
      params,
      onUserTranscript,
      handleVoiceEndSession,
      bargeIn,
      softBargeIn,
    } = buildParams({
      pendingInterrupt: null,
      routeArtifactReviewCommand,
    });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Sophia leave a comment: change the font');
    });

    expect(routeArtifactReviewCommand).toHaveBeenCalledWith('Sophia leave a comment: change the font');
    expect(handleVoiceEndSession).not.toHaveBeenCalled();
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).not.toHaveBeenCalled();
    expect(softBargeIn).toHaveBeenCalledTimes(1);
    expect(isSessionLeaveGuardSuppressedForAnnotation()).toBe(true);
  });

  it('suppresses session exit for annotation phrases even before a review target handles them', () => {
    const {
      params,
      onUserTranscript,
      handleVoiceEndSession,
      bargeIn,
      softBargeIn,
    } = buildParams({ pendingInterrupt: null });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Sophia leave a note on the title');
    });

    expect(handleVoiceEndSession).not.toHaveBeenCalled();
    expect(bargeIn).not.toHaveBeenCalled();
    expect(softBargeIn).not.toHaveBeenCalled();
    expect(onUserTranscript).toHaveBeenCalledWith('Sophia leave a note on the title');
    expect(isSessionLeaveGuardSuppressedForAnnotation()).toBe(true);
  });

  it('warns for wake-word download command when no builder deliverable is ready', () => {
    const {
      params,
      onUserTranscript,
      handleDownloadBuilderArtifact,
      showToast,
      bargeIn,
      softBargeIn,
    } = buildParams({ pendingInterrupt: null });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('Sophia download now');
    });

    expect(handleDownloadBuilderArtifact).not.toHaveBeenCalled();
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(bargeIn).not.toHaveBeenCalled();
    expect(softBargeIn).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'No deliverable ready to download yet.', variant: 'warning' }),
    );
  });

  it('normalizes accents/punctuation for spanish reflection command', () => {
    const {
      params,
      onUserTranscript,
      handleReflectionTap,
      showToast,
      softBargeIn,
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
    expect(softBargeIn).toHaveBeenCalledTimes(1);
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

  it('falls through for bare download phrase when no deliverable is ready', () => {
    const {
      params,
      onUserTranscript,
      handleDownloadBuilderArtifact,
    } = buildParams({ pendingInterrupt: null });

    const { result } = renderHook(() => useSessionVoiceCommandSystem(params));

    act(() => {
      result.current.handleVoiceTranscript('download now');
    });

    expect(onUserTranscript).toHaveBeenCalledWith('download now');
    expect(handleDownloadBuilderArtifact).not.toHaveBeenCalled();
  });
});
