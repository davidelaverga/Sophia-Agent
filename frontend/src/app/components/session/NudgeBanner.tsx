/**
 * NudgeBanner Component
 * Unit 6 — Glass pill nudge design
 *
 * Atmospheric nudge suggestions as whisper text + glass pill accept.
 */

'use client';

import { useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import type { InvokeType } from '../../lib/session-types';
import { cn } from '../../lib/utils';

// =============================================================================
// TYPES
// =============================================================================

export interface NudgeSuggestion {
  id: string;
  message: string;
  actionType: InvokeType;
  priority: 'low' | 'medium' | 'high';
  timestamp: string;
  reason?: string;
}

// =============================================================================
// NUDGE BANNER
// =============================================================================

interface NudgeBannerProps {
  suggestion: NudgeSuggestion;
  onAccept: (actionType: InvokeType) => void;
  onDismiss: () => void;
  onImpulse?: () => void;
  className?: string;
}

export function NudgeBanner({
  suggestion,
  onAccept,
  onDismiss,
  onImpulse,
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
    }, 400);
  };

  const handleAccept = () => {
    haptic('medium');
    onImpulse?.();
    setIsExiting(true);
    setTimeout(() => {
      setIsVisible(false);
      onAccept(suggestion.actionType);
    }, 400);
  };

  if (!isVisible) return null;

  return (
    <div
      className={cn(
        'mx-auto max-w-sm py-3 text-center',
        'transition-all duration-500',
        isExiting && 'opacity-0 translate-y-1',
        className
      )}
      role="status"
      aria-label="Sophia suggestion"
    >
      {/* Whisper suggestion — Cormorant italic */}
      <p className="mb-2.5 font-cormorant italic text-[14px]" style={{ color: 'var(--cosmic-text)' }}>
        {suggestion.message}
      </p>

      {/* Glass pill actions */}
      <div className="flex items-center justify-center gap-2.5">
        <button
          onClick={handleAccept}
          aria-label={`Accept: ${suggestion.message}`}
          className={cn(
            'cosmic-accent-pill cosmic-focus-ring rounded-full px-4 py-1.5',
            'text-[11px] tracking-[0.08em] uppercase',
            'transition-all duration-200',
            'active:scale-[0.97]',
          )}
        >
          yes
        </button>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss suggestion"
          className={cn(
            'cosmic-whisper-button cosmic-focus-ring rounded text-[10px] tracking-[0.08em]',
            'transition-all duration-200',
          )}
        >
          not now
        </button>
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
  onImpulse?: () => void;
  maxVisible?: number;
  className?: string;
}

export function NudgeQueue({
  nudges,
  onAccept,
  onDismiss,
  onImpulse,
  maxVisible = 1,
  className,
}: NudgeQueueProps) {
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
          onImpulse={onImpulse}
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
  onAccept: () => void;
  onDismiss: () => void;
  onImpulse?: () => void;
  className?: string;
}

export function MiniNudge({
  message,
  onAccept,
  onDismiss,
  onImpulse,
  className,
}: MiniNudgeProps) {
  return (
    <div className={cn(
      'mx-auto max-w-sm py-2 text-center',
      className
    )}>
      <p className="mb-2 font-cormorant italic text-[13px]" style={{ color: 'var(--cosmic-text)' }}>
        {message}
      </p>
      <div className="flex items-center justify-center gap-2.5">
        <button
          onClick={() => {
            haptic('light');
            onImpulse?.();
            onAccept();
          }}
          className={cn(
            'cosmic-accent-pill cosmic-focus-ring rounded-full px-3 py-1',
            'text-[10px] tracking-[0.08em] uppercase',
            'transition-all duration-200',
          )}
        >
          yes
        </button>
        <button
          onClick={() => {
            haptic('light');
            onDismiss();
          }}
          className={cn(
            'cosmic-whisper-button cosmic-focus-ring rounded text-[10px] tracking-[0.08em]',
            'transition-all duration-200',
          )}
        >
          not now
        </button>
      </div>
    </div>
  );
}

export default NudgeBanner;
