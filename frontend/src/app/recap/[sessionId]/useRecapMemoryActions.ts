import { useCallback, useRef, useState } from 'react';

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

function buildDiscardMetadata(category?: string): { status: 'discarded'; category?: string } {
  if (category) {
    return {
      status: 'discarded',
      category,
    };
  }

  return { status: 'discarded' };
}

type CandidateSnapshot = {
  candidate: NonNullable<RecapArtifactsV1['memoryCandidates']>[number];
  index: number;
};

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
  const artifactsRef = useRef<RecapArtifactsV1 | null>(artifacts);

  artifactsRef.current = artifacts;

  const getCandidateSnapshot = useCallback((candidateId: string): CandidateSnapshot | null => {
    const memoryCandidates = artifacts?.memoryCandidates || [];
    const index = memoryCandidates.findIndex((candidate) => candidate.id === candidateId);
    if (index < 0) {
      return null;
    }

    const candidate = memoryCandidates[index];
    if (!candidate) {
      return null;
    }

    return { candidate, index };
  }, [artifacts?.memoryCandidates]);

  const removeCandidateFromArtifacts = useCallback((candidateId: string) => {
    const currentArtifacts = artifactsRef.current;
    if (!currentArtifacts) return;

    const nextCandidates = (currentArtifacts.memoryCandidates || []).filter((candidate) => candidate.id !== candidateId);
    setArtifacts(sessionId, {
      ...currentArtifacts,
      memoryCandidates: nextCandidates,
    });
  }, [sessionId, setArtifacts]);

  const restoreCandidateInArtifacts = useCallback((snapshot: CandidateSnapshot) => {
    const currentArtifacts = artifactsRef.current;
    if (!currentArtifacts) return;

    const currentCandidates = currentArtifacts.memoryCandidates || [];
    if (currentCandidates.some((candidate) => candidate.id === snapshot.candidate.id)) {
      return;
    }

    const nextCandidates = [...currentCandidates];
    const insertIndex = Math.max(0, Math.min(snapshot.index, nextCandidates.length));
    nextCandidates.splice(insertIndex, 0, snapshot.candidate);

    setArtifacts(sessionId, {
      ...currentArtifacts,
      memoryCandidates: nextCandidates,
    });
  }, [sessionId, setArtifacts]);

  const handleDiscardCandidate = useCallback(async (candidateId: string) => {
    if (deletingIds[candidateId]) {
      return;
    }

    const candidateSnapshot = getCandidateSnapshot(candidateId);
    if (!candidateSnapshot) {
      return;
    }

    const { candidate } = candidateSnapshot;

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
    setDecision(sessionId, candidateId, 'discarded');
    removeCandidateFromArtifacts(candidateId);

    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(candidateId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          metadata: buildDiscardMetadata(candidate.category),
        }),
      });

      if (!response.ok) {
        throw new Error(`Discard failed: ${response.status}`);
      }

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
      restoreCandidateInArtifacts(candidateSnapshot);
      setDecision(sessionId, candidateId, 'idle');
    } finally {
      setDeletingIds((prev) => {
        const next = { ...prev };
        delete next[candidateId];
        return next;
      });
    }
  }, [deletingIds, getCandidateSnapshot, removeCandidateFromArtifacts, restoreCandidateInArtifacts, sessionId, setDecision, showToast]);

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
