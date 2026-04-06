/**
 * Recap Components
 * Phase 3 - Week 3
 * 
 * Modular components for the Recap screen:
 * - TakeawayCard
 * - ReflectionCard  
 * - MemoryCandidatesPanel
 * - RecapEmptyState
 */

'use client';

import type { 
  MemoryCandidateV1, 
  MemoryDecision,
} from '../../lib/recap-types';
import { cn } from '../../lib/utils';

import { RecapEmptyStateViews } from './RecapEmptyStateViews';
import { RecapMemoryCandidateRow } from './RecapMemoryCandidateRow';
export { TakeawayCard, ReflectionCard } from './RecapInsightCards';
import {
  RecapMemoryCandidatesFooter,
  RecapMemoryCandidatesIntro,
  RecapMemoryCandidatesLoadingState,
  RecapMemoryCandidatesNoDataState,
} from './RecapMemoryCandidatesFooter';

// =============================================================================
// MEMORY CANDIDATE ROW
// =============================================================================

// =============================================================================
// MEMORY CANDIDATES PANEL
// =============================================================================

interface MemoryCandidatesPanelProps {
  candidates?: MemoryCandidateV1[];
  decisions: Record<string, { decision: MemoryDecision; editedText?: string }>;
  onDecisionChange: (candidateId: string, decision: MemoryDecision, editedText?: string) => void;
  onSaveApproved?: () => void;
  isLoading?: boolean;
  isSaving?: boolean;
  className?: string;
}

export function MemoryCandidatesPanel({
  candidates,
  decisions,
  onDecisionChange,
  onSaveApproved,
  isLoading,
  isSaving,
  className,
}: MemoryCandidatesPanelProps) {
  const approvedCount = Object.values(decisions).filter(
    d => d.decision === 'approved' || d.decision === 'edited'
  ).length;
  
  if (isLoading) {
    return <RecapMemoryCandidatesLoadingState className={className} />;
  }
  
  if (!candidates || candidates.length === 0) {
    return <RecapMemoryCandidatesNoDataState className={className} />;
  }
  
  return (
    <div className={cn(
      'bg-sophia-surface rounded-2xl p-7 border border-sophia-surface-border',
      className
    )}>
      <RecapMemoryCandidatesIntro candidatesCount={candidates.length} />
      
      {/* Candidates list */}
      <div className="space-y-4">
        {candidates.slice(0, 3).map((candidate) => {
          const dec = decisions[candidate.id] || { decision: 'idle' as MemoryDecision };
          return (
            <RecapMemoryCandidateRow
              key={candidate.id}
              candidate={candidate}
              decision={dec.decision}
              editedText={dec.editedText}
              onApprove={() => onDecisionChange(candidate.id, 'approved')}
              onEdit={(text) => onDecisionChange(candidate.id, 'edited', text)}
              onDiscard={() => onDecisionChange(candidate.id, 'discarded')}
              disabled={isSaving}
            />
          );
        })}
      </div>
      
      <RecapMemoryCandidatesFooter
        approvedCount={approvedCount}
        onSaveApproved={onSaveApproved}
        isSaving={isSaving}
      />
    </div>
  );
}

// =============================================================================
// RECAP EMPTY STATE
// =============================================================================

interface RecapEmptyStateProps {
  status: 'processing' | 'unavailable' | 'not_found';
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export function RecapEmptyState({ status, onRetry, onDismiss, className }: RecapEmptyStateProps) {
  return (
    <RecapEmptyStateViews
      status={status}
      onRetry={onRetry}
      onDismiss={onDismiss}
      className={className}
    />
  );
}
