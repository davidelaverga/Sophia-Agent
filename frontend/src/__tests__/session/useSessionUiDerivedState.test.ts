import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSessionUiDerivedState } from '../../app/session/useSessionUiDerivedState';
import type { UIMessage } from '../../app/components/session';

describe('useSessionUiDerivedState', () => {
  it('computes isSophiaResponding from streaming/voice/reflection state', () => {
    const base: {
      isTyping: boolean;
      messages: UIMessage[];
      artifacts: null;
      userOpenedArtifacts: boolean;
      sessionPresetType: undefined;
      sessionContextMode: undefined;
    } = {
      isTyping: false,
      messages: [],
      artifacts: null,
      userOpenedArtifacts: false,
      sessionPresetType: undefined,
      sessionContextMode: undefined,
    };

    const { result, rerender } = renderHook(
      ({
        isStreaming,
        isReflectionVoiceFlowActive,
        voiceStatus,
        isReflectionTtsActive,
      }: {
        isStreaming: boolean;
        isReflectionVoiceFlowActive: boolean;
        voiceStatus: 'ready' | 'listening' | 'thinking' | 'speaking';
        isReflectionTtsActive: boolean;
      }) =>
        useSessionUiDerivedState({
          ...base,
          isStreaming,
          isReflectionVoiceFlowActive,
          voiceStatus,
          isReflectionTtsActive,
        }),
      {
        initialProps: {
          isStreaming: true,
          isReflectionVoiceFlowActive: false,
          voiceStatus: 'ready',
          isReflectionTtsActive: false,
        },
      }
    );

    expect(result.current.isSophiaResponding).toBe(true);
    expect(result.current.exitProtectionResponseMode).toBe('text');

    rerender({
      isStreaming: false,
      isReflectionVoiceFlowActive: false,
      voiceStatus: 'thinking',
      isReflectionTtsActive: false,
    });
    expect(result.current.isSophiaResponding).toBe(true);
    expect(result.current.exitProtectionResponseMode).toBe('voice');

    rerender({
      isStreaming: false,
      isReflectionVoiceFlowActive: false,
      voiceStatus: 'speaking',
      isReflectionTtsActive: true,
    });
    expect(result.current.isSophiaResponding).toBe(false);
    expect(result.current.exitProtectionResponseMode).toBe('text');

    rerender({
      isStreaming: false,
      isReflectionVoiceFlowActive: true,
      voiceStatus: 'thinking',
      isReflectionTtsActive: false,
    });
    expect(result.current.isSophiaResponding).toBe(false);
    expect(result.current.exitProtectionResponseMode).toBe('voice');
  });

  it('derives showCompanionRail from messages, typing, and context mode', () => {
    const baseMessages: UIMessage[] = [
      {
        id: 'm1',
        role: 'user',
        content: 'hello',
        createdAt: new Date().toISOString(),
        isNew: false,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'hi',
        createdAt: new Date().toISOString(),
        isNew: false,
      },
    ];

    const { result, rerender } = renderHook(
      ({
        isTyping,
        sessionContextMode,
        messages,
      }: {
        isTyping: boolean;
        sessionContextMode: 'life' | 'gaming' | undefined;
        messages: UIMessage[];
      }) =>
        useSessionUiDerivedState({
          isTyping,
          messages,
          artifacts: null,
          isStreaming: false,
          isReflectionVoiceFlowActive: false,
          userOpenedArtifacts: false,
          voiceStatus: 'ready',
          isReflectionTtsActive: false,
          sessionPresetType: undefined,
          sessionContextMode,
        }),
      {
        initialProps: {
          isTyping: false,
          sessionContextMode: 'life' as const,
          messages: baseMessages,
        },
      }
    );

    expect(result.current.showCompanionRail).toBe(true);

    rerender({
      isTyping: true,
      sessionContextMode: 'life' as const,
      messages: baseMessages,
    });
    expect(result.current.showCompanionRail).toBe(false);

    rerender({
      isTyping: false,
      sessionContextMode: undefined,
      messages: baseMessages,
    });
    expect(result.current.showCompanionRail).toBe(false);

    rerender({
      isTyping: false,
      sessionContextMode: 'life' as const,
      messages: [baseMessages[0]],
    });
    expect(result.current.showCompanionRail).toBe(false);
  });
});
