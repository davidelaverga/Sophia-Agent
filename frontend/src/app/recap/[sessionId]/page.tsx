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
import { useCallback, useMemo } from 'react';

import {
  RecapMemoryOrbit,
  RecapEmptyState,
} from '../../components/recap';
import { BuilderDeliverableCard } from '../../components/session/ArtifactsPanel';
import { haptic } from '../../hooks/useHaptics';
import { buildRecapTelemetryReport } from '../../lib/recap-telemetry-report';
import type { MemoryDecision } from '../../lib/recap-types';
import { useRecapStore } from '../../stores/recap-store';
import { useSessionHistoryStore } from '../../stores/session-history-store';
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
  
  // Store
  const { 
    getArtifacts, 
    setArtifacts, 
    getDecisions, 
    setDecision,
    allCandidatesReviewed,
    commitMemories,
    getCommitStatus,
  } = useRecapStore();
  
  // Toast for feedback
  const showToast = useUiStore((state) => state.showToast);
  
  // Get artifacts from store (or mock for development)
  const artifacts = getArtifacts(sessionId);
  const decisions = getDecisions(sessionId);
  const historyEntry = useSessionHistoryStore((state) =>
    state.sessions.find((entry) => entry.sessionId === sessionId)
  );
  
  // Convert decisions array to map for easier access
  const decisionsMap = useMemo(() => {
    const map: Record<string, { decision: MemoryDecision; editedText?: string }> = {};
    for (const d of decisions) {
      map[d.candidateId] = { decision: d.decision, editedText: d.editedText };
    }
    return map;
  }, [decisions]);

  const { status, reload, telemetry } = useRecapArtifactsLoader({
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

  const handleExportDebug = useCallback(() => {
    try {
      const exportedAt = new Date().toISOString();
      const report = buildRecapTelemetryReport({
        sessionId,
        route: typeof window === 'undefined' ? `/recap/${sessionId}` : window.location.pathname,
        pageStatus: status,
        telemetry,
        artifacts,
        decisions,
        memoryCommitStatus: getCommitStatus(sessionId),
        historyEntry,
        exportedAt,
      });
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = exportedAt.replace(/[:.]/g, '-');
      anchor.href = href;
      anchor.download = `sophia-recap-telemetry-report-${sessionId}-${stamp}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      showToast({ message: 'Recap debug report exported.', variant: 'success', durationMs: 1800 });
    } catch {
      showToast({ message: 'Could not export recap debug report.', variant: 'error', durationMs: 2200 });
    }
  }, [
    artifacts,
    decisions,
    getCommitStatus,
    historyEntry,
    sessionId,
    showToast,
    status,
    telemetry,
  ]);
  
  // Show loading state
  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-transparent relative">
        <RecapPageFloatingHeader variant="skeleton" onExportDebug={handleExportDebug} />
        
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
          onExportDebug={handleExportDebug}
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
        onExportDebug={handleExportDebug}
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
