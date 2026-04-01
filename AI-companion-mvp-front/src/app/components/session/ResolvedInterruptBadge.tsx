/**
 * ResolvedInterruptBadge Component
 * Phase 2 - Sprint 1 (Premium Visual)
 * 
 * Compact "action receipt" showing user's interrupt choice
 * Auto-dismisses after a few seconds to not clutter the conversation
 * 
 * Example: ✓ Debrief · Yes, let's do it
 */

'use client';

import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ResolvedInterrupt } from '../../lib/session-types';

// ============================================================================
// TYPES
// ============================================================================

interface ResolvedInterruptBadgeProps {
  resolved: ResolvedInterrupt;
  className?: string;
  /** Auto-dismiss after this many ms (default: 4000) */
  autoDismissMs?: number;
}

// ============================================================================
// KIND LABELS (short form)
// ============================================================================

const KIND_LABELS: Record<string, string> = {
  DEBRIEF_OFFER: 'Debrief',
  RESET_OFFER: 'Reset',
  NUDGE_OFFER: 'Nudge',
  MICRO_DIALOG: 'Choice',
};

// ============================================================================
// COMPONENT
// ============================================================================

export function ResolvedInterruptBadge({ 
  resolved, 
  className,
  autoDismissMs = 4000,
}: ResolvedInterruptBadgeProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [isFading, setIsFading] = useState(false);
  const kindLabel = KIND_LABELS[resolved.kind] || 'Choice';
  
  // Auto-dismiss after timeout
  useEffect(() => {
    const fadeTimer = setTimeout(() => {
      setIsFading(true);
    }, autoDismissMs - 500); // Start fade 500ms before hide
    
    const hideTimer = setTimeout(() => {
      setIsVisible(false);
    }, autoDismissMs);
    
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [autoDismissMs]);
  
  if (!isVisible) return null;
  
  return (
    <div
      className={cn(
        // Layout - compact inline receipt
        'inline-flex items-center gap-2',
        'py-1.5 px-3 mx-auto',
        // Styling - subtle, uses theme tokens
        'bg-sophia-button/50',
        'rounded-full',
        // Border uses theme token (no hardcoded white)
        'border border-sophia-surface-border',
        // Muted presence
        'opacity-70',
        // Animation
        'transition-all duration-500',
        isFading && 'opacity-0 scale-95',
        className
      )}
    >
      {/* Check icon - success indicator */}
      <div className="flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/20">
        <Check className="w-2.5 h-2.5 text-emerald-600 dark:text-emerald-400" />
      </div>
      
      {/* Content - muted label · normal response */}
      <span className="text-[13px] leading-none">
        <span className="text-sophia-text2 opacity-60 font-medium">
          {kindLabel}
        </span>
        <span className="text-sophia-text2 opacity-40 mx-1.5">·</span>
        <span className="text-sophia-text2 opacity-80">
          {resolved.selectedOption.label}
        </span>
      </span>
    </div>
  );
}

export default ResolvedInterruptBadge;
