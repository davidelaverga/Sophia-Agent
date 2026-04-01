/**
 * NudgeBanner Component
 * Phase 3 - Subphase 3.4
 * 
 * Display-only nudge suggestions that appear during a session.
 * Sophia can suggest companion actions based on conversation patterns.
 */

'use client';

import { useState } from 'react';
import { X, Lightbulb, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import type { InvokeType } from '../../lib/session-types';

// =============================================================================
// TYPES
// =============================================================================

export interface NudgeSuggestion {
  /** Unique ID for this nudge */
  id: string;
  /** The suggestion message */
  message: string;
  /** Which companion action to trigger */
  actionType: InvokeType;
  /** Priority level */
  priority: 'low' | 'medium' | 'high';
  /** When the nudge was created */
  timestamp: string;
  /** Optional reason for the suggestion */
  reason?: string;
}

// =============================================================================
// STYLES
// =============================================================================

const PRIORITY_STYLES: Record<NudgeSuggestion['priority'], string> = {
  high: 'border-l-amber-500 bg-amber-500/5',
  medium: 'border-l-sophia-purple bg-sophia-purple/5',
  low: 'border-l-sophia-surface-border bg-sophia-surface/50',
};

const ACTION_LABELS: Record<InvokeType, string> = {
  quick_question: 'Ask a quick question',
  plan_reminder: 'Review your plan',
  tilt_reset: 'Take a reset',
  micro_debrief: 'Quick reflection',
};

// =============================================================================
// NUDGE BANNER
// =============================================================================

interface NudgeBannerProps {
  suggestion: NudgeSuggestion;
  onAccept: (actionType: InvokeType) => void;
  onDismiss: () => void;
  className?: string;
}

export function NudgeBanner({
  suggestion,
  onAccept,
  onDismiss,
  className,
}: NudgeBannerProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [isExiting, setIsExiting] = useState(false);
  
  const handleDismiss = () => {
    haptic('light');
    setIsExiting(true);
    setTimeout(() => {
      setIsVisible(false);
      onDismiss();
    }, 200);
  };
  
  const handleAccept = () => {
    haptic('medium');
    setIsExiting(true);
    setTimeout(() => {
      setIsVisible(false);
      onAccept(suggestion.actionType);
    }, 200);
  };
  
  if (!isVisible) return null;
  
  return (
    <div
      className={cn(
        'mx-4 mt-4 p-4 rounded-xl border-l-4 transition-all duration-200',
        PRIORITY_STYLES[suggestion.priority],
        isExiting && 'opacity-0 -translate-y-2',
        className
      )}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={cn(
          'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
          'bg-sophia-purple/10'
        )}>
          <Lightbulb className="w-4 h-4 text-sophia-purple" />
        </div>
        
        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-sophia-text mb-1">
            💡 Suggestion
          </p>
          <p className="text-sm text-sophia-text2 leading-relaxed">
            {suggestion.message}
          </p>
          {suggestion.reason && (
            <p className="text-xs text-sophia-text2/60 mt-1 italic">
              {suggestion.reason}
            </p>
          )}
        </div>
        
        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={handleAccept}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium',
              'bg-sophia-purple text-white',
              'hover:bg-sophia-purple/90 transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
            )}
          >
            {ACTION_LABELS[suggestion.actionType]}
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={handleDismiss}
            className={cn(
              'p-1.5 rounded-lg transition-colors',
              'text-sophia-text2 hover:text-sophia-text hover:bg-sophia-surface-border/50',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
            )}
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// NUDGE QUEUE (manages multiple nudges)
// =============================================================================

interface NudgeQueueProps {
  nudges: NudgeSuggestion[];
  onAccept: (actionType: InvokeType, nudgeId: string) => void;
  onDismiss: (nudgeId: string) => void;
  maxVisible?: number;
  className?: string;
}

export function NudgeQueue({
  nudges,
  onAccept,
  onDismiss,
  maxVisible = 1,
  className,
}: NudgeQueueProps) {
  // Show only the first N nudges, prioritizing high priority
  const sortedNudges = [...nudges]
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    })
    .slice(0, maxVisible);
  
  if (sortedNudges.length === 0) return null;
  
  return (
    <div className={cn('space-y-2', className)}>
      {sortedNudges.map((nudge) => (
        <NudgeBanner
          key={nudge.id}
          suggestion={nudge}
          onAccept={(actionType) => onAccept(actionType, nudge.id)}
          onDismiss={() => onDismiss(nudge.id)}
        />
      ))}
    </div>
  );
}

// =============================================================================
// MINI NUDGE (compact inline version)
// =============================================================================

interface MiniNudgeProps {
  message: string;
  actionType: InvokeType;
  onAccept: () => void;
  onDismiss: () => void;
  className?: string;
}

export function MiniNudge({
  message,
  actionType,
  onAccept,
  onDismiss,
  className,
}: MiniNudgeProps) {
  return (
    <div className={cn(
      'inline-flex items-center gap-2 px-3 py-2 rounded-xl',
      'bg-sophia-surface border border-sophia-surface-border',
      'text-sm',
      className
    )}>
      <Lightbulb className="w-4 h-4 text-sophia-purple flex-shrink-0" />
      <span className="text-sophia-text2">{message}</span>
      <button
        onClick={() => {
          haptic('light');
          onAccept();
        }}
        className="text-sophia-purple hover:underline font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple rounded"
      >
        {ACTION_LABELS[actionType]}
      </button>
      <button
        onClick={() => {
          haptic('light');
          onDismiss();
        }}
        className="text-sophia-text2/50 hover:text-sophia-text2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple rounded"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

export default NudgeBanner;
