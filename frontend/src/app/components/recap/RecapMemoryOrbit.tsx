/**
 * Recap Memory Orbit Component
 * 
 * A cinematic, emotionally immersive memory selection experience.
 * This is the "Cosmic Focus Stage" - a centered, atmospheric,
 * focus-driven experience for reviewing session insights.
 * 
 * Design Principles:
 * - Dark, soft, cosmic stage with radial glow
 * - Focus-driven: everything centered vertically
 * - Calm, meditative motion (400-600ms transitions)
 * - Emotionally safe decisions (not gamey)
 * - Full keyboard navigation + screen reader support
 */

'use client';

import { useRef, useMemo } from 'react';
import { cn } from '../../lib/utils';
import type { MemoryCandidateV1, MemoryDecision } from '../../lib/recap-types';
import {
  getOrbitCandidateBuckets,
  getSafeFocusedIndex,
  getVisibleOrbitCandidates,
  normalizeOrbitCandidates,
} from './RecapMemoryOrbitUtils';
import { useRecapMemoryOrbitController } from './useRecapMemoryOrbitController';
import { useRecapMemoryOrbitSelection } from './useRecapMemoryOrbitSelection';
import {
  CosmicBackground,
  KeyTakeaway,
  RecapOrbitCompleted,
  RecapOrbitEmpty,
  RecapOrbitLoading,
  ReflectionPrompt,
} from './RecapMemoryOrbitVisuals';
import { CosmicMemoryBubble } from './RecapMemoryOrbitBubble';
import { RecapMemoryOrbitNavigation } from './RecapMemoryOrbitNavigation';
import { RecapMemoryOrbitAnnouncements } from './RecapMemoryOrbitAnnouncements';
import { OnboardingTipGuard } from '../onboarding';

// =============================================================================
// TYPES
// =============================================================================

interface RecapMemoryOrbitProps {
  /** Key takeaway headline */
  takeaway?: string;
  /** Memory candidates */
  candidates?: MemoryCandidateV1[];
  /** Current decisions for each candidate */
  decisions: Record<string, { decision: MemoryDecision; editedText?: string }>;
  /** Callback when user makes a decision */
  onDecisionChange: (candidateId: string, decision: MemoryDecision, editedText?: string) => void;
  /** Reflection prompt */
  reflectionPrompt?: string;
  /** Reflection tag */
  reflectionTag?: string;
  /** Callback when user wants to reflect */
  onReflect?: () => void;
  /** Loading state */
  isLoading?: boolean;
  /** Whether actions are disabled */
  disabled?: boolean;
  /** Additional className */
  className?: string;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function RecapMemoryOrbit({
  takeaway,
  candidates,
  decisions,
  onDecisionChange,
  reflectionPrompt,
  reflectionTag,
  onReflect,
  isLoading,
  disabled,
  className,
}: RecapMemoryOrbitProps) {
  const normalizedCandidates = useMemo(() => normalizeOrbitCandidates(candidates), [candidates]);

  const approvedMemories = useMemo(
    () => normalizedCandidates.flatMap((candidate) => {
      const decisionRecord = decisions[candidate.id];
      if (!decisionRecord) {
        return [];
      }

      if (decisionRecord.decision !== 'approved' && decisionRecord.decision !== 'edited') {
        return [];
      }

      const originalText = (candidate.text ?? candidate.memory ?? '').trim();
      const refinedText = decisionRecord.editedText?.trim();

      return [{
        id: candidate.id,
        text: decisionRecord.decision === 'edited' && refinedText ? refinedText : originalText,
        isEdited: decisionRecord.decision === 'edited',
      }];
    }),
    [decisions, normalizedCandidates]
  );

  const { activeCandidates, processedCandidates, approvedCount } = useMemo(
    () => getOrbitCandidateBuckets(normalizedCandidates, decisions),
    [normalizedCandidates, decisions]
  );

  const containerRef = useRef<HTMLDivElement>(null);

  const {
    focusedIndex,
    setFocusedIndex,
    exitingId,
    exitAnimation,
    navigatePrev,
    navigateNext,
    handleKeep,
    handleEdit,
    handleDiscard,
  } = useRecapMemoryOrbitController({
    activeCandidates,
    disabled,
    onDecisionChange: (candidateId, decision, editedText) => onDecisionChange(candidateId, decision, editedText),
  });

  const { handleSelectIndex, handleSelectCandidateById } = useRecapMemoryOrbitSelection({
    activeCandidates,
    disabled,
    exitingId,
    setFocusedIndex,
  });

  // Loading state
  if (isLoading) {
    return <RecapOrbitLoading />;
  }

  // Empty state
  if (!candidates || candidates.length === 0) {
    return <RecapOrbitEmpty />;
  }

  if (normalizedCandidates.length === 0) {
    return <RecapOrbitEmpty />;
  }

  // All processed state
  if (activeCandidates.length === 0 && processedCandidates.length > 0) {
    return (
      <RecapOrbitCompleted 
        approvedCount={approvedCount}
        approvedMemories={approvedMemories}
        takeaway={takeaway}
        reflectionPrompt={reflectionPrompt}
        reflectionTag={reflectionTag}
        onReflect={onReflect}
      />
    );
  }

  const safeFocusedIndex = getSafeFocusedIndex(focusedIndex, activeCandidates.length);
  const visibleCandidates = getVisibleOrbitCandidates(activeCandidates, safeFocusedIndex);
  const focusedCandidate = activeCandidates[safeFocusedIndex];

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative min-h-screen flex flex-col items-center justify-center py-12 overflow-hidden',
        className
      )}
      role="region"
      aria-label="Memory selection experience"
    >
      <OnboardingTipGuard tipId="tip-first-recap" isTriggered={Boolean(takeaway || reflectionPrompt || normalizedCandidates.length > 0)} />
      <OnboardingTipGuard tipId="tip-first-memory-candidate" isTriggered={normalizedCandidates.length > 0} />
      <CosmicBackground />
      
      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-4xl px-6">
        {/* Key Takeaway Headline */}
        <div data-onboarding="recap-summary">
          <KeyTakeaway takeaway={takeaway} />
        </div>
        
        {/* Memory Orbit Container - nudged slightly higher for reference match */}
        <div 
          className="relative w-full flex items-center justify-center -mt-4"
          style={{ minHeight: '400px' }}
        >
          <RecapMemoryOrbitNavigation
            activeCandidates={activeCandidates}
            focusedIndex={focusedIndex}
            disabled={disabled}
            isExiting={!!exitingId}
            onPrev={navigatePrev}
            onNext={navigateNext}
            onSelectIndex={handleSelectIndex}
          />
          
          {/* Memory bubbles */}
          <div className="relative w-full h-[360px] sm:h-[400px] flex items-center justify-center">
            {visibleCandidates.map(({ candidate, position }) => (
              <CosmicMemoryBubble
                key={`${candidate.id}-${position}`}
                candidate={candidate}
                position={position}
                isExiting={candidate.id === exitingId}
                exitAnimation={candidate.id === exitingId ? exitAnimation : null}
                onKeep={() => handleKeep(candidate.id)}
                onEdit={(editedText) => handleEdit(candidate.id, editedText)}
                onDiscard={() => handleDiscard(candidate.id)}
                onClick={() => handleSelectCandidateById(candidate.id, position)}
                disabled={disabled || position !== 'center' || !!exitingId}
              />
            ))}
          </div>
        </div>
        
        {/* Reflection Prompt */}
        <ReflectionPrompt 
          prompt={reflectionPrompt}
          tag={reflectionTag}
          onReflect={onReflect}
        />
      </div>
      
      <RecapMemoryOrbitAnnouncements
        focusedCandidate={focusedCandidate}
        safeFocusedIndex={safeFocusedIndex}
        activeCandidatesCount={activeCandidates.length}
        exitingId={exitingId}
        exitAnimation={exitAnimation}
      />
    </div>
  );
}

export default RecapMemoryOrbit;
