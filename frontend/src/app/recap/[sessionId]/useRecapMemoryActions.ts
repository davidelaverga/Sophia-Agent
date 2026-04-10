import { useCallback, useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { errorCopy } from '../../lib/error-copy';
import { logger } from '../../lib/error-logger';
import type { MemoryDecision, RecapArtifactsV1 } from '../../lib/recap-types';
import { useSessionHistoryStore } from '../../stores/session-history-store';

type DecisionMap = Array<{ candidateId: string; decision: MemoryDecision; editedText?: string }>;

type ShowToast = (payload: {
  message: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  durationMs?: number;
}) => void;

interface UseRecapMemoryActionsParams {
  artifacts: RecapArtifactsV1 | null;
  decisions: DecisionMap;
  sessionId: string;
  setArtifacts: (sessionId: string, artifacts: RecapArtifactsV1) => void;
  setDecision: (sessionId: string, candidateId: string, decision: MemoryDecision, editedText?: string) => void;
  commitMemories: (sessionId: string, threadId?: string) => Promise<{ committed: string[]; discarded: string[]; errors: Array<{ candidate_id: string; message: string }> }>;
  showToast: ShowToast;
  navigateAfterSave: (result: { committed: string[]; discarded: string[]; errors: Array<{ candidate_id: string; message: string }> }) => void;
}

interface UseRecapMemoryActionsResult {
  isSaving: boolean;
  actionError: string | null;
  actionRetry: (() => void) | null;
  saveSuccess: { count: number } | null;
  handleDecisionChange: (candidateId: string, decision: MemoryDecision, editedText?: string) => void;
  handleSaveApproved: () => Promise<void>;
  dismissActionError: () => void;
}

function isLegacyCandidateId(candidateId: string): boolean {
  return candidateId.startsWith('candidate-') || /^mem_\d+$/.test(candidateId);
}

export function useRecapMemoryActions({
  artifacts,
  decisions,
  sessionId,
  setArtifacts,
  setDecision,
  commitMemories,
  showToast,
  navigateAfterSave,
}: UseRecapMemoryActionsParams): UseRecapMemoryActionsResult {
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionRetry, setActionRetry] = useState<(() => void) | null>(null);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [saveSuccess, setSaveSuccess] = useState<{ count: number } | null>(null);

  const removeCandidateFromArtifacts = useCallback((candidateId: string) => {
    if (!artifacts) return;
    const nextCandidates = (artifacts.memoryCandidates || []).filter((candidate) => candidate.id !== candidateId);
    setArtifacts(sessionId, {
      ...artifacts,
      memoryCandidates: nextCandidates,
    });
  }, [artifacts, sessionId, setArtifacts]);

  const handleDiscardCandidate = useCallback(async (candidateId: string) => {
    if (deletingIds[candidateId]) {
      return;
    }

    const candidate = artifacts?.memoryCandidates?.find((item) => item.id === candidateId);
    if (!candidate) {
      return;
    }

    setActionError(null);
    setActionRetry(null);

    if (isLegacyCandidateId(candidateId)) {
      setDecision(sessionId, candidateId, 'discarded');
      removeCandidateFromArtifacts(candidateId);
      showToast({
        message: 'Memory discarded.',
        variant: 'info',
        durationMs: 1800,
      });
      return;
    }

    setDeletingIds((prev) => ({ ...prev, [candidateId]: true }));

    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(candidateId)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`Discard failed: ${response.status}`);
      }

      setDecision(sessionId, candidateId, 'discarded');
      removeCandidateFromArtifacts(candidateId);
      showToast({
        message: 'Memory discarded.',
        variant: 'info',
        durationMs: 1800,
      });
    } catch (error) {
      logger.logError(error, {
        component: 'Recap',
        action: 'discard_memory',
      });
      const retry = () => {
        void handleDiscardCandidate(candidateId);
      };
      setActionError("Couldn't remove this memory. Try again?");
      setActionRetry(() => retry);
      setDecision(sessionId, candidateId, 'idle');
    } finally {
      setDeletingIds((prev) => {
        const next = { ...prev };
        delete next[candidateId];
        return next;
      });
    }
  }, [artifacts?.memoryCandidates, deletingIds, removeCandidateFromArtifacts, sessionId, setDecision, showToast]);

  const handleDecisionChange = useCallback((candidateId: string, decision: MemoryDecision, editedText?: string) => {
    if (decision === 'discarded') {
      void handleDiscardCandidate(candidateId);
      return;
    }

    const nextEditedText = typeof editedText === 'string' ? editedText.trim() : undefined;
    setActionError(null);
    setActionRetry(null);
    setDecision(sessionId, candidateId, decision, nextEditedText);

    if (decision === 'approved') {
      showToast({
        message: 'Memory saved.',
        variant: 'success',
        durationMs: 1500,
      });
    }

    if (decision === 'edited') {
      showToast({
        message: 'Refined memory saved.',
        variant: 'success',
        durationMs: 1500,
      });
    }
  }, [handleDiscardCandidate, sessionId, setDecision, showToast]);

  const handleSaveApproved = useCallback(async () => {
    setIsSaving(true);
    setActionError(null);
    setActionRetry(null);
    haptic('medium');

    try {
      const approvedCount = decisions.filter(
        (decision) => decision.decision === 'approved' || decision.decision === 'edited'
      ).length;

      let commitResult = { committed: [], discarded: [], errors: [] as Array<{ candidate_id: string; message: string }> };

      if (approvedCount > 0) {
        commitResult = await commitMemories(sessionId);
        if (commitResult.errors.length > 0 || commitResult.committed.length < approvedCount) {
          throw new Error(errorCopy.couldntSaveMemories);
        }
        useSessionHistoryStore.getState().markMemoriesApproved(sessionId);
      }

      haptic('success');
      setSaveSuccess({ count: approvedCount });

      showToast({
        message: 'Memory review completed.',
        variant: 'success',
        durationMs: 3000,
      });

      setTimeout(() => {
        navigateAfterSave(commitResult);
      }, 1500);
    } catch (error) {
      logger.logError(error, {
        component: 'Recap',
        action: 'save_memories',
      });
      setActionError(errorCopy.couldntSaveMemories);
      setActionRetry(() => () => {
        void handleSaveApproved();
      });
      haptic('error');
    } finally {
      setIsSaving(false);
    }
  }, [commitMemories, decisions, navigateAfterSave, sessionId, showToast]);

  const dismissActionError = useCallback(() => {
    setActionError(null);
    setActionRetry(null);
  }, []);

  return {
    isSaving,
    actionError,
    actionRetry,
    saveSuccess,
    handleDecisionChange,
    handleSaveApproved,
    dismissActionError,
  };
}
