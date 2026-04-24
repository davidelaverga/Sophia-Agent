/**
 * Recap Page - Dynamic Route
 * /recap/[sessionId]
 * 
 * Phase 3 - Week 3: Artifacts + Memory Approval
 * 
 * Features:
 * - Display session takeaway (hero card)
 * - Reflection prompt with action button
 * - Memory candidates panel with approve/edit/discard
 * - Trust UI elements
 * - Empty states for each section
 */

'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  RecapMemoryOrbit,
  RecapEmptyState,
} from '../../components/recap';
import { BuilderDeliverableCard } from '../../components/session/ArtifactsPanel';
import { haptic } from '../../hooks/useHaptics';
import type { MemoryDecision } from '../../lib/recap-types';
import { useRecapStore } from '../../stores/recap-store';
import { useUiStore } from '../../stores/ui-store';

import {
  RecapBottomActionBar,
  RecapPageFloatingHeader,
  RecapSaveSuccessOverlay,
} from './RecapPageChrome';
import { useRecapArtifactsLoader } from './useRecapArtifactsLoader';
import { useRecapMemoryActions } from './useRecapMemoryActions';

export default function RecapPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as string;
  const [hasClientHydrated, setHasClientHydrated] = useState(false);

  useEffect(() => {
    setHasClientHydrated(true);
  }, []);
  
  // Store
  const { 
    getArtifacts, 
    setArtifacts, 
    setDecision,
    allCandidatesReviewed,
    commitMemories,
  } = useRecapStore();
  
  // Toast for feedback
  const showToast = useUiStore((state) => state.showToast);
  
  // Delay reading persisted recap state until after mount so the first client
  // render matches the server render and avoids hydration mismatches.
  const artifacts = hasClientHydrated ? getArtifacts(sessionId) ?? null : null;
  // Subscribe directly to the decisions slice for this session so the memo
  // below recomputes when decisions change.
  const sessionDecisions = useRecapStore((s) => s.decisions[sessionId]);
  const decisions = useMemo(
    () => (hasClientHydrated ? (sessionDecisions ?? []) : []),
    [hasClientHydrated, sessionDecisions],
  );
  
  // Convert decisions array to map for easier access
  const decisionsMap = useMemo(() => {
    const map: Record<string, { decision: MemoryDecision; editedText?: string }> = {};
    for (const d of decisions) {
      map[d.candidateId] = { decision: d.decision, editedText: d.editedText };
    }
    return map;
  }, [decisions]);

  const { status, reload } = useRecapArtifactsLoader({
    sessionId,
    artifacts,
    setArtifacts,
  });

  const {
    isSaving,
    actionError,
    actionRetry,
    saveSuccess,
    handleDecisionChange,
    handleSaveApproved,
    dismissActionError,
  } = useRecapMemoryActions({
    artifacts,
    decisions,
    sessionId,
    setArtifacts,
    setDecision,
    commitMemories,
    showToast,
    navigateAfterSave: (result) => {
      const params = new URLSearchParams();
      if (result.committed.length > 0) {
        params.set('highlight', result.committed.join(','));
      }
      params.set('source', 'recap');
      params.set('session', sessionId);
      const suffix = params.toString();
      router.push(suffix ? `/journal?${suffix}` : '/journal');
    },
  });
  
  // Handle retry
  const handleRetry = useCallback(() => {
    reload();
  }, [reload]);
  
  // Show loading state
  if (!hasClientHydrated || status === 'loading') {
    return (
      <div className="min-h-screen bg-transparent relative">
        <RecapPageFloatingHeader variant="skeleton" />
        
        {/* Cinematic loading - reuse RecapMemoryOrbit loading state */}
        <RecapMemoryOrbit
          isLoading
          decisions={{}}
          onDecisionChange={() => {}}
        />
      </div>
    );
  }
  
  // Show error/empty states
  if (status !== 'ready' || !artifacts) {
    return (
      <div className="min-h-screen bg-transparent relative">
        <RecapPageFloatingHeader
          variant="with-title"
          onBack={() => {
            haptic('light');
            router.push('/journal');
          }}
          onHome={() => {
            haptic('light');
            router.push('/journal');
          }}
        />
        
        <main className="min-h-screen flex items-center justify-center px-4">
          <RecapEmptyState 
            status={status === 'ready' ? 'unavailable' : status}
            onRetry={handleRetry}
            onDismiss={() => router.push('/journal')}
          />
        </main>
      </div>
    );
  }
  
  const allReviewed = allCandidatesReviewed(sessionId);
  const bottomPaddingClass = 'pb-36 sm:pb-40';
  
  return (
    <div className={`min-h-screen bg-transparent relative ${bottomPaddingClass}`}>
      <RecapPageFloatingHeader
        variant="compact"
        onBack={() => {
          haptic('light');
          router.back();
        }}
        onHome={() => {
          haptic('light');
          router.push('/journal');
        }}
      />

      {artifacts.builderArtifact && (
        <div className="mx-auto max-w-3xl px-4 pt-20">
          <BuilderDeliverableCard
            builderArtifact={artifacts.builderArtifact}
            threadId={artifacts.threadId}
          />
        </div>
      )}
      
      {/* Cinematic Memory Orbit Experience */}
      <RecapMemoryOrbit
        takeaway={artifacts.takeaway}
        candidates={artifacts.memoryCandidates}
        decisions={decisionsMap}
        onDecisionChange={handleDecisionChange}
        disabled={isSaving}
      />
      
      <RecapBottomActionBar
        actionError={actionError}
        actionRetry={actionRetry}
        onDismissError={dismissActionError}
        onReturnHome={() => {
          haptic('light');
          router.push('/journal');
        }}
        allReviewed={allReviewed}
        isSaving={isSaving}
        onComplete={handleSaveApproved}
      />
      
      {saveSuccess && <RecapSaveSuccessOverlay count={saveSuccess.count} />}
    </div>
  );
}
