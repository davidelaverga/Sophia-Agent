import type { MemoryCandidateV1 } from '../../lib/recap-types';

interface RecapMemoryOrbitAnnouncementsProps {
  focusedCandidate?: MemoryCandidateV1;
  safeFocusedIndex: number;
  activeCandidatesCount: number;
  exitingId: string | null;
  exitAnimation: 'keep' | 'discard' | null;
}

function getDisplayText(candidate: MemoryCandidateV1): string {
  return (candidate.text ?? candidate.memory ?? '').trim();
}

export function RecapMemoryOrbitAnnouncements({
  focusedCandidate,
  safeFocusedIndex,
  activeCandidatesCount,
  exitingId,
  exitAnimation,
}: RecapMemoryOrbitAnnouncementsProps) {
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {focusedCandidate && !exitingId && (
        <>Showing memory {safeFocusedIndex + 1} of {activeCandidatesCount}: {getDisplayText(focusedCandidate)}</>
      )}
      {exitingId && exitAnimation === 'keep' && (
        <>Memory saved</>
      )}
      {exitingId && exitAnimation === 'discard' && (
        <>Memory released</>
      )}
    </div>
  );
}
