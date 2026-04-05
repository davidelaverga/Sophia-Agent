import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { haptic } from '../../hooks/useHaptics';
import type { MemoryCandidateV1 } from '../../lib/recap-types';

interface UseRecapMemoryOrbitSelectionParams {
  activeCandidates: MemoryCandidateV1[];
  disabled?: boolean;
  exitingId: string | null;
  setFocusedIndex: Dispatch<SetStateAction<number>>;
}

interface UseRecapMemoryOrbitSelectionResult {
  handleSelectIndex: (index: number) => void;
  handleSelectCandidateById: (candidateId: string, position: 'center' | 'left' | 'right') => void;
}

export function useRecapMemoryOrbitSelection({
  activeCandidates,
  disabled,
  exitingId,
  setFocusedIndex,
}: UseRecapMemoryOrbitSelectionParams): UseRecapMemoryOrbitSelectionResult {
  const handleSelectIndex = useCallback((index: number) => {
    if (disabled || exitingId) return;
    haptic('light');
    setFocusedIndex(index);
  }, [disabled, exitingId, setFocusedIndex]);

  const handleSelectCandidateById = useCallback((candidateId: string, position: 'center' | 'left' | 'right') => {
    if (position === 'center' || disabled || exitingId) return;

    haptic('light');
    const targetIndex = activeCandidates.findIndex((candidate) => candidate.id === candidateId);
    if (targetIndex !== -1) {
      setFocusedIndex(targetIndex);
    }
  }, [activeCandidates, disabled, exitingId, setFocusedIndex]);

  return {
    handleSelectIndex,
    handleSelectCandidateById,
  };
}
