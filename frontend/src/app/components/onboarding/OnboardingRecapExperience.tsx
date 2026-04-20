'use client';

import { useEffect, useMemo, useState } from 'react';

import type { MemoryDecision } from '../../lib/recap-types';
import {
  RecapBottomActionBar,
  RecapPageFloatingHeader,
} from '../../recap/[sessionId]/RecapPageChrome';
import { useOnboardingStore } from '../../stores/onboarding-store';
import {
  RecapMemoryOrbit,
} from '../recap';
import { mockRecapArtifacts } from '../recap/mockData';

type DecisionMap = Record<string, { decision: MemoryDecision; editedText?: string }>;

const SAVE_READY_DECISIONS: DecisionMap = {
  'mem-1': { decision: 'approved' },
  'mem-2': { decision: 'discarded' },
  'mem-3': { decision: 'discarded' },
};

export function OnboardingRecapExperience() {
  const currentStepId = useOnboardingStore((state) => state.currentStepId);
  const [decisions, setDecisions] = useState<DecisionMap>({});

  useEffect(() => {
    if (currentStepId === 'recap-memory-save') {
      setDecisions((previous) => Object.keys(previous).length > 0 ? previous : SAVE_READY_DECISIONS);
    }
  }, [currentStepId]);

  const allReviewed = useMemo(
    () => mockRecapArtifacts.memoryCandidates.every((candidate) => Boolean(decisions[candidate.id])),
    [decisions],
  );

  const handleDecisionChange = (candidateId: string, decision: MemoryDecision, editedText?: string) => {
    setDecisions((previous) => ({
      ...previous,
      [candidateId]: { decision, editedText },
    }));
  };

  return (
    <div className="min-h-screen bg-sophia-bg relative pb-36 sm:pb-40">
      <RecapPageFloatingHeader
        variant="compact"
        onBack={() => undefined}
        onHome={() => undefined}
      />

      <RecapMemoryOrbit
        takeaway={mockRecapArtifacts.takeaway}
        candidates={mockRecapArtifacts.memoryCandidates}
        decisions={decisions}
        onDecisionChange={handleDecisionChange}
        disabled={false}
      />

      <RecapBottomActionBar
        actionError={null}
        actionRetry={null}
        onDismissError={() => undefined}
        onReturnHome={() => undefined}
        allReviewed={allReviewed}
        isSaving={false}
        onComplete={() => undefined}
      />
    </div>
  );
}