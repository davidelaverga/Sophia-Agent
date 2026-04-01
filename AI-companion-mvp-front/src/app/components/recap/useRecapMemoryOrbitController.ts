import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { haptic } from '../../hooks/useHaptics';
import type { MemoryCandidateV1 } from '../../lib/recap-types';

interface UseRecapMemoryOrbitControllerParams {
  activeCandidates: MemoryCandidateV1[];
  disabled?: boolean;
  onDecisionChange: (candidateId: string, decision: 'approved' | 'edited' | 'discarded', editedText?: string) => void;
}

interface UseRecapMemoryOrbitControllerResult {
  focusedIndex: number;
  setFocusedIndex: Dispatch<SetStateAction<number>>;
  exitingId: string | null;
  exitAnimation: 'keep' | 'discard' | null;
  navigatePrev: () => void;
  navigateNext: () => void;
  handleKeep: (candidateId: string) => void;
  handleEdit: (candidateId: string, editedText: string) => void;
  handleDiscard: (candidateId: string) => void;
}

const KEEP_ANIMATION_MS = 700;
const DISCARD_ANIMATION_MS = 600;

export function useRecapMemoryOrbitController({
  activeCandidates,
  disabled,
  onDecisionChange,
}: UseRecapMemoryOrbitControllerParams): UseRecapMemoryOrbitControllerResult {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [exitAnimation, setExitAnimation] = useState<'keep' | 'discard' | null>(null);
  const exitTimeoutRef = useRef<number | null>(null);

  const clearExitTimeout = useCallback(() => {
    if (exitTimeoutRef.current !== null) {
      window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (focusedIndex >= activeCandidates.length && activeCandidates.length > 0) {
      setFocusedIndex(Math.max(0, activeCandidates.length - 1));
    }
  }, [activeCandidates.length, focusedIndex]);

  const navigatePrev = useCallback(() => {
    if (activeCandidates.length <= 1 || exitingId) return;
    haptic('light');
    setFocusedIndex((prev) => (prev === 0 ? activeCandidates.length - 1 : prev - 1));
  }, [activeCandidates.length, exitingId]);

  const navigateNext = useCallback(() => {
    if (activeCandidates.length <= 1 || exitingId) return;
    haptic('light');
    setFocusedIndex((prev) => (prev === activeCandidates.length - 1 ? 0 : prev + 1));
  }, [activeCandidates.length, exitingId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled || activeCandidates.length === 0 || exitingId) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigatePrev();
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeCandidates.length, disabled, exitingId, navigateNext, navigatePrev]);

  const handleKeep = useCallback((candidateId: string) => {
    if (disabled || exitingId) return;
    haptic('medium');
    clearExitTimeout();
    setExitingId(candidateId);
    setExitAnimation('keep');

    exitTimeoutRef.current = window.setTimeout(() => {
      onDecisionChange(candidateId, 'approved');
      setExitingId(null);
      setExitAnimation(null);
      exitTimeoutRef.current = null;
    }, KEEP_ANIMATION_MS);
  }, [clearExitTimeout, disabled, exitingId, onDecisionChange]);

  const handleEdit = useCallback((candidateId: string, editedText: string) => {
    if (disabled || exitingId) return;
    haptic('medium');
    clearExitTimeout();
    setExitingId(candidateId);
    setExitAnimation('keep');

    exitTimeoutRef.current = window.setTimeout(() => {
      onDecisionChange(candidateId, 'edited', editedText);
      setExitingId(null);
      setExitAnimation(null);
      exitTimeoutRef.current = null;
    }, KEEP_ANIMATION_MS);
  }, [clearExitTimeout, disabled, exitingId, onDecisionChange]);

  const handleDiscard = useCallback((candidateId: string) => {
    if (disabled || exitingId) return;
    haptic('light');
    clearExitTimeout();
    setExitingId(candidateId);
    setExitAnimation('discard');

    exitTimeoutRef.current = window.setTimeout(() => {
      onDecisionChange(candidateId, 'discarded');
      setExitingId(null);
      setExitAnimation(null);
      exitTimeoutRef.current = null;
    }, DISCARD_ANIMATION_MS);
  }, [clearExitTimeout, disabled, exitingId, onDecisionChange]);

  useEffect(() => {
    return () => {
      clearExitTimeout();
    };
  }, [clearExitTimeout]);

  return {
    focusedIndex,
    setFocusedIndex,
    exitingId,
    exitAnimation,
    navigatePrev,
    navigateNext,
    handleKeep,
    handleEdit,
    handleDiscard,
  };
}
