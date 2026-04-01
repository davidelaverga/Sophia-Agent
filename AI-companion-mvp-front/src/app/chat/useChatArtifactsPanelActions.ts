import { useCallback, useState } from 'react';

import type { RecapArtifactsV1 } from '../types/recap';

type FocusMode = 'voice' | 'text' | 'full';

type MemoryInlineFeedback = {
  index: number;
  message: string;
  variant?: 'error' | 'info' | 'success';
} | null;

type UseChatArtifactsPanelActionsParams = {
  focusMode: FocusMode;
  setMode: (mode: FocusMode) => void;
  setManualOverride: (value: boolean) => void;
  handlePromptSelect: (prompt: string) => void;
  conversationId?: string;
  recapArtifacts?: RecapArtifactsV1;
  setRecapArtifacts: (sessionId: string, artifacts: RecapArtifactsV1) => void;
};

export function useChatArtifactsPanelActions({
  focusMode,
  setMode,
  setManualOverride,
  handlePromptSelect,
  conversationId,
  recapArtifacts,
  setRecapArtifacts,
}: UseChatArtifactsPanelActionsParams) {
  const [memoryInlineFeedback, setMemoryInlineFeedback] = useState<MemoryInlineFeedback>(null);

  const clearMemoryFeedbackSoon = useCallback(() => {
    window.setTimeout(() => setMemoryInlineFeedback(null), 2200);
  }, []);

  const handleReflectionTap = useCallback((reflection: { prompt: string }) => {
    handlePromptSelect(reflection.prompt);
    if (focusMode === 'voice') {
      setMode('text');
      setManualOverride(true);
    }
  }, [handlePromptSelect, focusMode, setMode, setManualOverride]);

  const handleMemoryApprove = useCallback(async (index: number) => {
    if (!conversationId || !recapArtifacts?.memoryCandidates) return;
    const candidate = recapArtifacts.memoryCandidates[index];
    if (!candidate) return;

    const memoryText = (candidate.text || candidate.memory || '').trim();
    if (!memoryText) return;

    try {
      const response = await fetch('/api/memory/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_text: memoryText,
          category: candidate.category,
          session_id: conversationId,
        }),
      });

      if (!response.ok) {
        setMemoryInlineFeedback({
          index,
          message: "I couldn't save that memory yet. Please try again.",
          variant: 'error',
        });
        clearMemoryFeedbackSoon();
        return;
      }

      const nextCandidates = recapArtifacts.memoryCandidates.filter((_, candidateIndex) => candidateIndex !== index);
      setRecapArtifacts(conversationId, {
        ...recapArtifacts,
        memoryCandidates: nextCandidates,
      });
      setMemoryInlineFeedback({
        index,
        message: 'Saved.',
        variant: 'success',
      });
      clearMemoryFeedbackSoon();
    } catch {
      setMemoryInlineFeedback({
        index,
        message: "I couldn't save that memory yet. Please try again.",
        variant: 'error',
      });
      clearMemoryFeedbackSoon();
    }
  }, [conversationId, recapArtifacts, setRecapArtifacts, clearMemoryFeedbackSoon]);

  const handleMemoryReject = useCallback(async (index: number) => {
    if (!conversationId || !recapArtifacts?.memoryCandidates) return;
    const candidate = recapArtifacts.memoryCandidates[index];
    if (!candidate) return;

    const memoryText = (candidate.text || candidate.memory || '').trim();
    if (!memoryText) return;

    try {
      const response = await fetch('/api/memory/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          memory_text: memoryText,
          category: candidate.category,
          session_id: conversationId,
        }),
      });

      if (!response.ok) {
        setMemoryInlineFeedback({
          index,
          message: "I couldn't confirm the rejection yet. Try again.",
          variant: 'error',
        });
        clearMemoryFeedbackSoon();
        return;
      }

      const nextCandidates = recapArtifacts.memoryCandidates.filter((_, candidateIndex) => candidateIndex !== index);
      setRecapArtifacts(conversationId, {
        ...recapArtifacts,
        memoryCandidates: nextCandidates,
      });
      setMemoryInlineFeedback({
        index,
        message: 'Skipped.',
        variant: 'info',
      });
      clearMemoryFeedbackSoon();
    } catch {
      setMemoryInlineFeedback({
        index,
        message: "I couldn't confirm the rejection yet. Try again.",
        variant: 'error',
      });
      clearMemoryFeedbackSoon();
    }
  }, [conversationId, recapArtifacts, setRecapArtifacts, clearMemoryFeedbackSoon]);

  return {
    memoryInlineFeedback,
    handleReflectionTap,
    handleMemoryApprove,
    handleMemoryReject,
  };
}
