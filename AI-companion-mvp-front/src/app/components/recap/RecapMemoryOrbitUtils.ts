import type { MemoryCandidateV1, MemoryDecision } from '../../lib/recap-types';

type OrbitDecisionRecord = Record<string, { decision: MemoryDecision; editedText?: string }>;

export type OrbitVisibleCandidate = {
  candidate: MemoryCandidateV1;
  position: 'left' | 'center' | 'right';
};

export function normalizeOrbitCandidates(candidates?: MemoryCandidateV1[]): MemoryCandidateV1[] {
  return (candidates || []).filter(
    (candidate): candidate is MemoryCandidateV1 =>
      !!candidate && typeof candidate.id === 'string' && candidate.id.length > 0
  );
}

export function getOrbitCandidateBuckets(
  normalizedCandidates: MemoryCandidateV1[],
  decisions: OrbitDecisionRecord
): {
  activeCandidates: MemoryCandidateV1[];
  processedCandidates: MemoryCandidateV1[];
  approvedCount: number;
} {
  const activeCandidates = normalizedCandidates.filter((candidate) => {
    const decision = decisions[candidate.id]?.decision;
    return decision !== 'approved' && decision !== 'edited' && decision !== 'discarded';
  });

  const processedCandidates = normalizedCandidates.filter((candidate) => {
    const decision = decisions[candidate.id]?.decision;
    return decision === 'approved' || decision === 'edited' || decision === 'discarded';
  });

  const approvedCount = processedCandidates.filter((candidate) => {
    const decision = decisions[candidate.id]?.decision;
    return decision === 'approved' || decision === 'edited';
  }).length;

  return { activeCandidates, processedCandidates, approvedCount };
}

export function getSafeFocusedIndex(focusedIndex: number, activeCandidatesLength: number): number {
  if (activeCandidatesLength <= 0) return 0;
  return Math.min(focusedIndex, activeCandidatesLength - 1);
}

export function getVisibleOrbitCandidates(
  activeCandidates: MemoryCandidateV1[],
  safeFocusedIndex: number
): OrbitVisibleCandidate[] {
  if (activeCandidates.length === 0) {
    return [];
  }

  if (activeCandidates.length === 1) {
    return [{ candidate: activeCandidates[0], position: 'center' }];
  }

  const leftIndex = safeFocusedIndex === 0 ? activeCandidates.length - 1 : safeFocusedIndex - 1;
  const rightIndex = safeFocusedIndex === activeCandidates.length - 1 ? 0 : safeFocusedIndex + 1;

  return [
    { candidate: activeCandidates[leftIndex], position: 'left' },
    { candidate: activeCandidates[safeFocusedIndex], position: 'center' },
    { candidate: activeCandidates[rightIndex], position: 'right' },
  ];
}
