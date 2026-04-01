/**
 * InterruptCard Component
 * Phase 2 - Sprint 1 (Companion-First Design)
 * 
 * Renders permissioned, interactive prompts from the backend
 * as INLINE suggestions, not modal interruptions.
 * 
 * Design philosophy:
 * - Feels like Sophia offering help, not system demanding attention
 * - Low visual prominence - doesn't compete with conversation
 * - 2 CTAs max + snooze as subtle link
 * - Part of the flow, not breaking it
 */

'use client';

import { useState, useCallback } from 'react';
import { 
  MessageSquare, 
  RefreshCw, 
  Clock, 
  Sparkles,
  Loader2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { errorCopy } from '../../lib/error-copy';
import { haptic } from '../../hooks/useHaptics';
import { logger } from '../../lib/error-logger';
import type { InterruptPayload, InterruptOption, InterruptKind } from '../../lib/session-types';

// ============================================================================
// TYPES
// ============================================================================

interface InterruptCardProps {
  interrupt: InterruptPayload;
  onSelect: (optionId: string) => Promise<void>;
  onSnooze?: () => void;
  onDismiss?: () => void;
  className?: string;
  isLoading?: boolean;
}

type CardStatus = 'idle' | 'loading' | 'success' | 'error';

// ============================================================================
// ICON MAP
// ============================================================================

const INTERRUPT_ICONS: Record<InterruptKind, typeof MessageSquare> = {
  DEBRIEF_OFFER: MessageSquare,
  RESET_OFFER: RefreshCw,
  NUDGE_OFFER: Sparkles,
  MICRO_DIALOG: Clock,
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function InterruptCard({
  interrupt,
  onSelect,
  onSnooze,
  onDismiss,
  className,
  isLoading: externalLoading = false,
}: InterruptCardProps) {
  const [status, setStatus] = useState<CardStatus>('idle');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  
  // Get icon with fallback - ensure we always have an icon
  const Icon = INTERRUPT_ICONS[interrupt.kind] || Sparkles;
  const isLoading = status === 'loading' || externalLoading;
  
  // Get primary and secondary options (max 2 buttons)
  const primaryOption = interrupt.options.find(o => o.style === 'primary');
  const secondaryOption = interrupt.options.find(o => o.style === 'secondary' || o.style !== 'primary');
  const mainOptions = [primaryOption, secondaryOption].filter(Boolean).slice(0, 2) as InterruptOption[];
  const tertiaryOption = interrupt.options.find((option) =>
    option.style === 'ghost' && !mainOptions.some((visibleOption) => visibleOption.id === option.id)
  );
  
  // Handle option click
  const handleOptionClick = useCallback(async (option: InterruptOption) => {
    if (isLoading) return;
    
    haptic('medium');
    setStatus('loading');
    setSelectedId(option.id);
    
    try {
      await onSelect(option.id);
      setStatus('success');
    } catch (error) {
      logger.logError(error, { component: 'InterruptCard', action: 'select_option' });
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2000);
    }
  }, [isLoading, onSelect]);
  
  // Handle snooze
  const handleSnooze = useCallback(() => {
    haptic('light');
    onSnooze?.();
  }, [onSnooze]);
  
  // Handle dismiss (same as snooze for now)
  const _handleDismiss = useCallback(() => {
    haptic('light');
    onDismiss?.();
  }, [onDismiss]);
  
  return (
    <div
      className={cn(
        // Layout - inline with conversation, not modal
        'relative w-full max-w-sm mx-auto',
        // Subtle presence - doesn't compete with messages
        'py-4 px-5',
        'rounded-2xl',
        // Very subtle background using theme tokens
        'bg-sophia-bubble',
        // Minimal border using theme
        'border border-sophia-surface-border',
        // Smooth appearance
        'transition-all duration-300',
        isLoading && 'opacity-70',
        className
      )}
      data-onboarding="interruption-card"
      role="region"
      aria-label={interrupt.title}
      aria-busy={isLoading}
    >
      {/* Compact header - icon + title inline */}
      <div className="flex items-center gap-2.5 mb-3">
        <div 
          className={cn(
            'relative flex-shrink-0 w-9 h-9 rounded-lg',
            'flex items-center justify-center',
          )}
        >
          {/* Background layer with opacity */}
          <div className="absolute inset-0 rounded-lg bg-sophia-purple opacity-20" />
          {/* Icon on top, full opacity */}
          <Icon className="relative z-10 w-5 h-5 text-sophia-purple" strokeWidth={2} />
        </div>
        
        <p className="text-[15px] font-semibold text-sophia-text">
          {interrupt.title}
        </p>
      </div>
      
      {/* Message - readable but not demanding */}
      <p className={cn(
        'text-[14px] leading-relaxed',
        'text-sophia-text2',
        'mb-4'
      )}>
        {interrupt.message}
      </p>
      
      {/* CTAs - max 2, compact */}
      <div className="flex items-center gap-2">
        {mainOptions.map((option, idx) => {
          const isPrimary = idx === 0;
          const isSelected = selectedId === option.id;
          
          return (
            <button
              key={option.id}
              onClick={() => handleOptionClick(option)}
              disabled={isLoading}
              className={cn(
                'h-9 px-4 rounded-full',
                'flex items-center justify-center gap-1.5',
                'text-[13px] font-medium',
                'transition-all duration-150',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
                'active:scale-[0.97]',
                // Primary - sophia purple
                isPrimary && [
                  'bg-sophia-purple text-white',
                  'hover:brightness-105',
                ],
                // Secondary - theme button
                !isPrimary && [
                  'bg-sophia-button text-sophia-text',
                  'border border-sophia-surface-border',
                  'hover:bg-sophia-button-hover',
                ],
              )}
            >
              {isSelected && isLoading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Continuing…
                </span>
              ) : (
                option.label
              )}
            </button>
          );
        })}
      </div>

      {tertiaryOption && (
        <button
          onClick={() => void handleOptionClick(tertiaryOption)}
          disabled={isLoading}
          className={cn(
            'mt-2 text-[12px] text-sophia-text2 opacity-70',
            'hover:opacity-95 hover:underline',
            'transition-all',
            'disabled:cursor-not-allowed',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/40 rounded'
          )}
        >
          {tertiaryOption.label}
        </button>
      )}
      
      {/* Snooze - tiny link, not a button */}
      {interrupt.kind !== 'MICRO_DIALOG' && 'snooze' in interrupt && interrupt.snooze && onSnooze && (
        <button
          onClick={handleSnooze}
          disabled={isLoading}
          className={cn(
            'mt-3 w-full',
            'text-[12px] text-sophia-text2 opacity-60',
            'hover:opacity-90 hover:underline',
            'transition-all',
            'disabled:cursor-not-allowed',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/40 rounded'
          )}
        >
          Remind me later
        </button>
      )}
      
      {/* Error - subtle inline */}
      {status === 'error' && (
        <p className="mt-2 text-[12px] text-sophia-error" role="alert" aria-live="polite">
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
