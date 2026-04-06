import { useEffect } from 'react';

import { useInterrupt } from '../hooks/useInterrupt';
import { debugLog } from '../lib/debug-logger';
import type { ContextMode, PresetType, RitualArtifacts } from '../lib/session-types';
import type { InterruptPayload } from '../types/session';

import type { StreamArtifactsPayload } from './stream-contract-adapters';

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  parts: Array<{ type: 'text'; text: string }>;
};

type UseSessionInterruptOrchestrationParams = {
  sessionId: string;
  threadId?: string;
  sessionContextMode?: ContextMode;
  sessionPresetType?: PresetType;
  artifacts: RitualArtifacts | null;
  ingestArtifacts: (incoming: StreamArtifactsPayload, source: 'stream' | 'interrupt' | 'companion' | 'voice') => void;
  setChatMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  clearResumeError: () => void;
  handleResumeError: (error: unknown) => void;
  setInterruptSelectHandler: (handler: (optionId: string) => Promise<void>) => void;
  setStreamInterruptHandler?: (handler: (interrupt: InterruptPayload) => void) => void;
  showToast: (args: { message: string; variant: 'info' | 'success' | 'error' | 'warning'; durationMs?: number }) => void;
  isTyping?: boolean;
};

export function useSessionInterruptOrchestration({
  sessionId,
  threadId,
  sessionContextMode,
  sessionPresetType,
  artifacts,
  ingestArtifacts,
  setChatMessages,
  clearResumeError,
  handleResumeError,
  setInterruptSelectHandler,
  setStreamInterruptHandler,
  showToast,
  isTyping = false,
}: UseSessionInterruptOrchestrationParams) {
  const {
    pendingInterrupt,
    interruptQueue,
    resolvedInterrupts,
    isResuming,
    threadId: interruptThreadId,
    detectedEmotion,
    handleInterruptSelect,
    handleInterruptSnooze,
    handleInterruptDismiss,
    setInterrupt,
  } = useInterrupt({
    sessionId,
    threadId,
    presetContext: sessionContextMode,
    sessionType: sessionPresetType,
    onArtifacts: (newArtifacts) => {
      if (process.env.NODE_ENV !== 'production') {
        const memoryCandidates = newArtifacts.memory_candidates || [];
        debugLog('SessionPage', 'onArtifacts merged', {
          has_takeaway: !!artifacts?.takeaway,
          has_reflection: !!artifacts?.reflection_candidate?.prompt,
          memory_candidates_count: Array.isArray(memoryCandidates) ? memoryCandidates.length : 0,
        });
      }

      ingestArtifacts(newArtifacts, 'interrupt');
    },
    onResumeSuccess: (response) => {
      const newId = `resume-${Date.now()}`;
      setChatMessages((prev) => [
        ...prev,
        {
          id: newId,
          role: 'assistant',
          parts: [{ type: 'text', text: response }],
        },
      ]);
      clearResumeError();
      showToast({
        message: 'Session updated',
        variant: 'success',
        durationMs: 2000,
      });
    },
    onResumeError: (error) => {
      handleResumeError(error);
    },
  });

  useEffect(() => {
    setInterruptSelectHandler(handleInterruptSelect);
  }, [setInterruptSelectHandler, handleInterruptSelect]);

  useEffect(() => {
    if (!setStreamInterruptHandler) return;
    setStreamInterruptHandler(setInterrupt);
  }, [setInterrupt, setStreamInterruptHandler]);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const reason = !pendingInterrupt
      ? 'no_pending_interrupt'
      : isTyping
        ? 'is_typing'
        : 'ready';
    debugLog('SessionPage', 'InterruptCard render check', {
      has_pending_interrupt: !!pendingInterrupt,
      is_typing: isTyping,
      reason,
    });
  }, [pendingInterrupt, isTyping]);

  return {
    pendingInterrupt,
    interruptQueue,
    resolvedInterrupts,
    isResuming,
    interruptThreadId,
    detectedEmotion,
    handleInterruptSnooze,
    handleInterruptDismiss,
    setInterrupt,
  };
}
