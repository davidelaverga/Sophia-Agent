import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useStreamVoiceSessionMock = vi.fn();

vi.mock('../../app/hooks/useStreamVoiceSession', () => ({
  useStreamVoiceSession: (...args: unknown[]) => useStreamVoiceSessionMock(...args),
}));

import { useCompanionVoiceRuntime } from '../../app/companion-runtime/voice-runtime';

type CapturedVoiceOptions = {
  onUserTranscript?: (text: string) => void;
  onAssistantResponse?: (text: string) => void;
  onArtifacts?: (artifacts: Record<string, unknown>) => void;
};

function makeVoiceState() {
  return {
    stage: 'listening' as const,
    partialReply: '',
    finalReply: '',
    error: undefined,
    startTalking: vi.fn(async () => undefined),
    stopTalking: vi.fn(async () => undefined),
    bargeIn: vi.fn(),
    resetVoiceState: vi.fn(),
    hasRetryableVoiceTurn: () => false,
    retryLastVoiceTurn: async () => false,
    isReflectionTtsActive: false,
    needsUnlock: false,
    path: undefined,
    stream: null,
    unlockAudio: vi.fn(),
    speakText: vi.fn(async () => false),
  };
}

describe('live voice artifact contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the live sophia.artifact payload shape into canonical voice artifact ingestion', () => {
    let capturedOptions: CapturedVoiceOptions | undefined;

    useStreamVoiceSessionMock.mockImplementation((userId: string, options: CapturedVoiceOptions) => {
      capturedOptions = options;
      return makeVoiceState();
    });

    const ingestArtifacts = vi.fn();

    renderHook(() =>
      useCompanionVoiceRuntime({
        userId: 'user-1',
        sessionId: 'session-1',
        onUserTranscriptFallback: vi.fn(),
        appendAssistantMessage: vi.fn(),
        ingestArtifacts,
        onRateLimitError: vi.fn(),
        sendMessage: vi.fn(async () => undefined),
        latestAssistantMessage: undefined,
        isTyping: false,
      })
    );

    const artifactPayload = {
      session_goal: 'Week 1 voice proof',
      active_goal: 'Keep the user in a short, grounded loop.',
      next_step: 'Listen for the next user turn.',
      takeaway: 'The user stayed with the feeling instead of bailing out.',
      reflection: null,
      tone_estimate: 2.0,
      tone_target: 2.5,
      active_tone_band: 'engagement',
      skill_loaded: 'active_listening',
      ritual_phase: 'free_conversation.opening',
      voice_emotion_primary: 'calm',
      voice_emotion_secondary: 'sympathetic',
      voice_speed: 'gentle',
    };

    act(() => {
      capturedOptions?.onArtifacts?.(artifactPayload);
    });

    expect(ingestArtifacts).toHaveBeenCalledWith(artifactPayload, 'voice');
  });

  it('routes final live transcript events into the canonical assistant message append path', () => {
    let capturedOptions: CapturedVoiceOptions | undefined;

    useStreamVoiceSessionMock.mockImplementation((userId: string, options: CapturedVoiceOptions) => {
      capturedOptions = options;
      return makeVoiceState();
    });

    const appendAssistantMessage = vi.fn();

    renderHook(() =>
      useCompanionVoiceRuntime({
        userId: 'user-1',
        sessionId: 'session-1',
        onUserTranscriptFallback: vi.fn(),
        appendAssistantMessage,
        ingestArtifacts: vi.fn(),
        onRateLimitError: vi.fn(),
        sendMessage: vi.fn(async () => undefined),
        latestAssistantMessage: undefined,
        isTyping: false,
      })
    );

    act(() => {
      capturedOptions?.onAssistantResponse?.('I heard you. Let\'s stay with this for a second.');
    });

    expect(appendAssistantMessage).toHaveBeenCalledWith(
      'I heard you. Let\'s stay with this for a second.',
      false,
    );
  });
});