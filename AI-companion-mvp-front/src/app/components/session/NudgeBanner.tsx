/**
 * NudgeBanner Component
 * Unit 6 — Glass pill nudge design
 *
 * Atmospheric nudge suggestions as whisper text + glass pill accept.
 */

'use client';

import { useState } from 'react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import type { InvokeType } from '../../lib/session-types';

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
      <p className="font-cormorant italic text-[14px] text-white/40 mb-2.5">
        {suggestion.message}
      </p>

      {/* Glass pill actions */}
      <div className="flex items-center justify-center gap-2.5">
        <button
          onClick={handleAccept}
          aria-label={`Accept: ${suggestion.message}`}
          className={cn(
            'px-4 py-1.5 rounded-full',
            'text-[11px] tracking-[0.08em] uppercase',
            'bg-white/[0.06] border border-white/[0.08]',
            'text-white/60',
            'transition-all duration-200',
            'hover:bg-white/[0.10] hover:text-white/80',
            'active:scale-[0.97]',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20',
          )}
        >
          yes
        </button>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss suggestion"
          className={cn(
            'text-[10px] tracking-[0.08em] text-white/20',
            'hover:text-white/35',
            'transition-all duration-200',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20 rounded'
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
      <p className="font-cormorant italic text-[13px] text-white/35 mb-2">
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
            'px-3 py-1 rounded-full',
            'text-[10px] tracking-[0.08em] uppercase',
            'bg-white/[0.06] border border-white/[0.08]',
            'text-white/50',
            'transition-all duration-200',
            'hover:bg-white/[0.10] hover:text-white/70',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20',
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
            'text-[10px] tracking-[0.08em] text-white/20',
            'hover:text-white/35',
            'transition-all duration-200',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20 rounded'
          )}
        >
          not now
        </button>
      </div>
    </div>
  );
}

export default NudgeBanner;
