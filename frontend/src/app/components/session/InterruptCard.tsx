/**
 * InterruptCard Component
 * Unit 6 — Glass pill interrupt design
 *
 * Renders as atmospheric glass pills with a whisper prompt above.
 * Each pill selection triggers a core-intensity impulse on the
 * PresenceField for visual feedback.
 */

'use client';

import { Loader2 } from 'lucide-react';
import { useState, useCallback } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { errorCopy } from '../../lib/error-copy';
import { logger } from '../../lib/error-logger';
import type { InterruptPayload, InterruptOption } from '../../lib/session-types';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface InterruptCardProps {
  interrupt: InterruptPayload;
  onSelect: (optionId: string) => Promise<void>;
  onSnooze?: () => void;
  onDismiss?: () => void;
  onImpulse?: () => void;
  className?: string;
  isLoading?: boolean;
}

type CardStatus = 'idle' | 'loading' | 'success' | 'error';

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function InterruptCard({
  interrupt,
  onSelect,
  onSnooze,
  onDismiss: _onDismiss,
  onImpulse,
  className,
  isLoading: externalLoading = false,
}: InterruptCardProps) {
  const [status, setStatus] = useState<CardStatus>('idle');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const isLoading = status === 'loading' || externalLoading;

  // Get primary and secondary options (max 2 pills)
  const primaryOption = interrupt.options.find(o => o.style === 'primary');
  const secondaryOption = interrupt.options.find(o => o.style === 'secondary' || o.style !== 'primary');
  const mainOptions = [primaryOption, secondaryOption].filter(Boolean).slice(0, 2);
  const tertiaryOption = interrupt.options.find((option) =>
    option.style === 'ghost' && !mainOptions.some((visibleOption) => visibleOption.id === option.id)
  );

  const handleOptionClick = useCallback(async (option: InterruptOption) => {
    if (isLoading) return;

    haptic('medium');
    setStatus('loading');
    setSelectedId(option.id);
    onImpulse?.();

    try {
      await onSelect(option.id);
      setStatus('success');
    } catch (error) {
      logger.logError(error, { component: 'InterruptCard', action: 'select_option' });
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2000);
    }
  }, [isLoading, onSelect, onImpulse]);

  const handleSnooze = useCallback(() => {
    haptic('light');
    onSnooze?.();
  }, [onSnooze]);

  return (
    <div
      className={cn(
        'relative w-full max-w-sm mx-auto py-3',
        'transition-all duration-500',
        isLoading && 'opacity-70',
        className
      )}
      data-onboarding="interruption-card"
      role="region"
      aria-label={interrupt.title}
      aria-busy={isLoading}
    >
      {/* Whisper prompt — Cormorant italic */}
      <p className="mb-3 text-center font-cormorant italic text-[14px]" style={{ color: 'var(--cosmic-text)' }}>
        {interrupt.message}
      </p>

      {/* Glass pills row */}
      <div className="flex items-center justify-center gap-2.5">
        {mainOptions.map((option) => {
          const isSelected = selectedId === option.id;

          return (
            <button
              key={option.id}
              onClick={() => handleOptionClick(option)}
              disabled={isLoading}
              className={cn(
                'rounded-full px-4 py-1.5',
                'text-[11px] tracking-[0.08em] uppercase',
                'transition-all duration-200',
                'active:scale-[0.97]',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'cosmic-focus-ring',
                isSelected ? 'cosmic-accent-pill' : 'cosmic-ghost-pill',
              )}
            >
              {isSelected && isLoading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                </span>
              ) : (
                option.label
              )}
            </button>
          );
        })}
      </div>

      {/* Tertiary ghost option */}
      {tertiaryOption && (
        <div className="flex justify-center mt-2">
          <button
            onClick={() => void handleOptionClick(tertiaryOption)}
            disabled={isLoading}
            className={cn(
              'cosmic-whisper-button cosmic-focus-ring rounded text-[10px] tracking-[0.08em]',
              'transition-all duration-200',
              'disabled:cursor-not-allowed',
            )}
          >
            {tertiaryOption.label}
          </button>
        </div>
      )}

      {/* Snooze — whisper link */}
      {interrupt.kind !== 'MICRO_DIALOG' && 'snooze' in interrupt && interrupt.snooze && onSnooze && (
        <div className="flex justify-center mt-2">
          <button
            onClick={handleSnooze}
            disabled={isLoading}
            className={cn(
              'cosmic-whisper-button cosmic-focus-ring rounded text-[10px] tracking-[0.08em]',
              'transition-all duration-200',
              'disabled:cursor-not-allowed',
            )}
          >
            remind me later
          </button>
        </div>
      )}

      {/* Error — subtle inline */}
      {status === 'error' && (
        <p className="mt-2 text-center text-[10px] text-red-400/60" role="alert" aria-live="polite">
          {errorCopy.connectionInterrupted}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { InterruptCardProps };
