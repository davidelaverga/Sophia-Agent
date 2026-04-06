/**
 * ResolvedInterruptBadge Component
 * Unit 6 — R37: 2s whisper flash
 *
 * Ephemeral confirmation that fades through quickly — not a persistent badge.
 */

'use client';

import { useState, useEffect } from 'react';

import type { ResolvedInterrupt } from '../../lib/session-types';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface ResolvedInterruptBadgeProps {
  resolved: ResolvedInterrupt;
  className?: string;
  autoDismissMs?: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ResolvedInterruptBadge({
  resolved,
  className,
  autoDismissMs = 2000,
}: ResolvedInterruptBadgeProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => {
      setIsFading(true);
    }, autoDismissMs - 800);

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
    <p
      className={cn(
        'text-center text-[10px] tracking-[0.12em] uppercase',
        'transition-all duration-700',
        isFading && 'opacity-0',
        className
      )}
      style={{ color: 'var(--cosmic-text-faint)' }}
    >
      {resolved.selectedOption.label}
    </p>
  );
}

export default ResolvedInterruptBadge;
