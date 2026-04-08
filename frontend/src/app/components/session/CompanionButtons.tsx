/**
 * Companion Buttons Component
 * Phase 3 - Subphase 3.3
 * 
 * Quick action buttons during session:
 * - Quick Question (❓)
 * - Plan Reminder (📋)
 * - Tilt Reset (🧘)
 * - Micro Debrief (📝)
 * 
 * Gaming-first, but adapts to context mode.
 */

'use client';

import { 
  HelpCircle, 
  ClipboardList, 
  Zap, 
  FileText,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { useState, useCallback } from 'react';

import { haptic } from '../../hooks/useHaptics';
import type { InvokeType, ContextMode } from '../../lib/session-types';
import { cn } from '../../lib/utils';

// =============================================================================
// TYPES & CONFIG
// =============================================================================

interface CompanionAction {
  type: InvokeType;
  icon: typeof HelpCircle;
  emoji: string;
  labels: Record<ContextMode, { title: string; description: string }>;
  color: string;
}

const COMPANION_ACTIONS: CompanionAction[] = [
  {
    type: 'quick_question',
    icon: HelpCircle,
    emoji: '❓',
    labels: {
      gaming: { title: 'Quick Q', description: 'Quick clarification' },
      work: { title: 'Quick Q', description: 'Brief question' },
      life: { title: 'Quick Q', description: 'Quick question' },
    },
    color: 'bg-sophia-purple/10 text-sophia-purple hover:bg-sophia-purple/20',
  },
  {
    type: 'plan_reminder',
    icon: ClipboardList,
    emoji: '📋',
    labels: {
      gaming: { title: 'Game Plan', description: 'Review your plan' },
      work: { title: 'My Plan', description: 'Review objectives' },
      life: { title: 'My Plan', description: 'Recall intentions' },
    },
    color: 'bg-sophia-purple/10 text-sophia-purple hover:bg-sophia-purple/20',
  },
  {
    type: 'tilt_reset',
    icon: Zap,
    emoji: '🧘',
    labels: {
      gaming: { title: 'Reset Tilt', description: 'Quick reset' },
      work: { title: 'Stress Reset', description: 'Quick calm' },
      life: { title: 'Ground Me', description: 'Center yourself' },
    },
    color: 'bg-sophia-purple/10 text-sophia-purple hover:bg-sophia-purple/20',
  },
  {
    type: 'micro_debrief',
    icon: FileText,
    emoji: '📝',
    labels: {
      gaming: { title: 'Mini Debrief', description: 'Quick reflection' },
      work: { title: 'Quick Reflect', description: 'Brief check-in' },
      life: { title: 'Quick Reflect', description: 'Brief reflection' },
    },
    color: 'bg-sophia-purple/10 text-sophia-purple hover:bg-sophia-purple/20',
  },
];

// COMPANION BUTTONS PANEL
// =============================================================================

interface CompanionButtonsProps {
  contextMode: ContextMode;
  transcript: string;
  threadId?: string;
  onInvoke: (invokeType: InvokeType) => Promise<void>;
  isInvoking?: boolean;
  activeInvoke?: InvokeType | null;
  disabled?: boolean;
  className?: string;
}

export function CompanionButtons({
  contextMode,
  transcript: _transcript,
  onInvoke,
  isInvoking = false,
  activeInvoke = null,
  disabled = false,
  className,
}: CompanionButtonsProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleInvoke = useCallback(async (invokeType: InvokeType) => {
    await onInvoke(invokeType);
    setIsOpen(false);
  }, [onInvoke]);
  
  return (
    <div className={cn('inline-flex', className)}>
      <div className={cn(
        'inline-flex items-center gap-1 rounded-full transition-all duration-300',
        'bg-sophia-surface',
        'px-1.5 py-1.5 border border-sophia-surface-border',
        isOpen ? 'shadow-lg' : 'shadow-none',
      )}>
        {/* Trigger */}
        <button
          onClick={() => {
            haptic('light');
            setIsOpen(!isOpen);
          }}
          disabled={disabled}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-200',
            'text-sophia-text2 text-xs font-medium',
            'hover:text-sophia-purple',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            isOpen && 'bg-sophia-purple/10 text-sophia-purple',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          <Zap className="w-3.5 h-3.5" />
          <span>Companion</span>
          <ChevronDown className={cn(
            'w-3 h-3 transition-transform duration-200',
            isOpen && 'rotate-180'
          )} />
        </button>

        {/* Expanded actions */}
        {isOpen && (
          <div className="flex items-center gap-1 animate-fadeIn">
            <div className="w-px h-5 bg-sophia-surface-border mx-0.5" />
            {COMPANION_ACTIONS.map((action) => {
              const Icon = action.icon;
              const label = action.labels[contextMode];
              const isActive = activeInvoke === action.type;
              const isDisabled = disabled || (isInvoking && !isActive);

              return (
                <button
                  key={action.type}
                  onClick={() => {
                    if (!isDisabled && !isInvoking) {
                      haptic('light');
                      void handleInvoke(action.type);
                    }
                  }}
                  disabled={isDisabled || isInvoking}
                  title={label.description}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all duration-200',
                    'text-xs font-medium text-sophia-text2',
                    'hover:bg-sophia-purple/10 hover:text-sophia-purple',
                    'active:scale-[0.97]',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
                    isActive && 'bg-sophia-purple/15 text-sophia-purple',
                    isDisabled && 'opacity-40 cursor-not-allowed',
                  )}
                >
                  {isInvoking && isActive ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Icon className="w-3.5 h-3.5" />
                  )}
                  <span>{label.title}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// COMPACT VERSION (for mobile/small screens)
// Opens as a floating popover so it doesn't push layout.
// =============================================================================

interface CompanionButtonsCompactProps {
  contextMode: ContextMode;
  onInvoke: (invokeType: InvokeType) => Promise<void>;
  isInvoking?: boolean;
  activeInvoke?: InvokeType | null;
  disabled?: boolean;
  /** Mobile-only: render trigger as icon-only pill (no visible text) */
  iconOnly?: boolean;
  className?: string;
}

export function CompanionButtonsCompact({
  contextMode,
  onInvoke,
  isInvoking = false,
  activeInvoke = null,
  disabled = false,
  iconOnly = false,
  className,
}: CompanionButtonsCompactProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const handleInvoke = useCallback(async (invokeType: InvokeType) => {
    await onInvoke(invokeType);
    setIsExpanded(false);
  }, [onInvoke]);

  return (
    <div className={cn('relative', className)}>
      {/* Trigger pill */}
      <button
        onClick={() => {
          haptic('light');
          setIsExpanded(!isExpanded);
        }}
        disabled={disabled}
        aria-label={iconOnly ? 'Quick actions' : undefined}
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all',
          'bg-sophia-surface border border-sophia-surface-border',
          'hover:border-sophia-purple/30 hover:shadow-md',
          'text-sophia-text2 text-sm',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
          isExpanded && 'border-sophia-purple/40 shadow-md',
          disabled && 'opacity-50 cursor-not-allowed',
          iconOnly && 'w-11 h-11 px-0 py-0 justify-center',
        )}
      >
        <Zap className={cn('w-4 h-4', isExpanded ? 'text-sophia-purple' : '')} />
        {!iconOnly && <span>Quick Actions</span>}
      </button>

      {/* Floating popover */}
      {isExpanded && (
        <>
          {/* Backdrop – closes on tap */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsExpanded(false)}
          />

          {/* Popover card */}
          <div
            className={cn(
              'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50',
              'w-[280px] p-3 rounded-2xl',
              'bg-sophia-surface/95',
              'border border-sophia-surface-border',
              'shadow-[0_8px_32px_rgba(0,0,0,0.35),0_0_0_1px_var(--card-border)]',
              'animate-fadeIn',
            )}
          >
            {/* Grid of actions */}
            <div className="grid grid-cols-2 gap-2">
              {COMPANION_ACTIONS.map((action) => {
                const Icon = action.icon;
                const label = action.labels[contextMode];
                const isActive = activeInvoke === action.type;
                const isDisabled = disabled || (isInvoking && !isActive);

                return (
                  <button
                    key={action.type}
                    onClick={() => {
                      if (!isDisabled && !isInvoking) {
                        haptic('light');
                        void handleInvoke(action.type);
                      }
                    }}
                    disabled={isDisabled || isInvoking}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all duration-200',
                      'bg-sophia-surface hover:bg-sophia-button-hover',
                      'border border-transparent',
                      'active:scale-[0.97]',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
                      isActive && 'border-sophia-purple/50 bg-sophia-purple/10',
                      isDisabled && 'opacity-40 cursor-not-allowed',
                    )}
                    title={label.description}
                  >
                    <span className={cn(
                      'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
                      action.color,
                    )}>
                      {isInvoking && isActive ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Icon className="w-4 h-4" />
                      )}
                    </span>
                    <span className="text-xs font-medium text-sophia-text text-left leading-tight">
                      {label.title}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Pointer triangle */}
            <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-sophia-surface/95 border-r border-b border-sophia-surface-border" />
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// COMPANION RAIL – Side tab that opens a floating popover of quick actions.
// Mirrors ArtifactsRail (right) but sits on the LEFT edge.
// =============================================================================

interface CompanionRailProps {
  contextMode: ContextMode;
  onInvoke: (invokeType: InvokeType) => Promise<void>;
  isInvoking?: boolean;
  activeInvoke?: InvokeType | null;
  disabled?: boolean;
  forceOpen?: boolean;
  triggerOnboardingId?: string;
  popoverOnboardingId?: string;
  className?: string;
}

export function CompanionRail({
  contextMode,
  onInvoke,
  isInvoking = false,
  activeInvoke = null,
  disabled = false,
  forceOpen = false,
  triggerOnboardingId,
  popoverOnboardingId,
  className,
}: CompanionRailProps) {
  const [isOpen, setIsOpen] = useState(false);
  const railIsOpen = forceOpen || isOpen;

  const handleInvoke = useCallback(async (invokeType: InvokeType) => {
    await onInvoke(invokeType);
    setIsOpen(false);
  }, [onInvoke]);

  return (
    <div className={cn('relative', className)}>
      {/* Ghost pill trigger */}
      <button
        onClick={() => {
          haptic('light');
          setIsOpen(!isOpen);
        }}
        disabled={disabled}
        data-onboarding={triggerOnboardingId}
        className={cn(
          'flex items-center justify-center w-full h-full',
          'transition-all duration-200',
          'opacity-40 hover:opacity-100',
          railIsOpen && 'opacity-100',
          disabled && 'opacity-20 cursor-not-allowed',
        )}
        title="Companion quick actions"
        aria-label="Companion quick actions"
      >
        <Zap className={cn(
          'w-4 h-4 text-sophia-text2 transition-colors',
          'hover:text-sophia-purple',
          railIsOpen && 'text-sophia-purple',
        )} />
      </button>

      {/* Floating popover with actions */}
      {railIsOpen && (
        <>
          {/* Backdrop */}
          {!forceOpen && <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />}

          {/* Popover – positioned to the right of the rail */}
          <div
            data-onboarding={popoverOnboardingId}
            className={cn(
              'absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50',
              'w-[200px] p-2.5 rounded-2xl',
              'bg-sophia-surface',
              'border border-sophia-surface-border',
              'shadow-[0_8px_32px_rgba(0,0,0,0.35),0_0_0_1px_var(--card-border)]',
              'animate-fadeIn',
            )}
          >
            <div className="flex flex-col gap-1">
              {COMPANION_ACTIONS.map((action) => {
                const Icon = action.icon;
                const label = action.labels[contextMode];
                const isActive = activeInvoke === action.type;
                const isActionDisabled = disabled || (isInvoking && !isActive);

                return (
                  <button
                    key={action.type}
                    onClick={() => {
                      if (!isActionDisabled && !isInvoking) {
                        haptic('light');
                        void handleInvoke(action.type);
                      }
                    }}
                    disabled={isActionDisabled || isInvoking}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all duration-200',
                      'hover:bg-sophia-button-hover',
                      'text-left',
                      'active:scale-[0.97]',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
                      isActive && 'bg-sophia-purple/10',
                      isActionDisabled && 'opacity-40 cursor-not-allowed',
                    )}
                    title={label.description}
                  >
                    <span className={cn(
                      'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
                      action.color,
                    )}>
                      {isInvoking && isActive ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Icon className="w-4 h-4" />
                      )}
                    </span>
                    <span className="text-xs font-medium text-sophia-text">
                      {label.title}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default CompanionButtons;
