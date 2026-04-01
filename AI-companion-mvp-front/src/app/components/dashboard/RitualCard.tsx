/**
 * RitualCard Component
 * Floating card for ritual selection (Prepare, Debrief, Reset, Vent)
 * 
 * Supports 3 layout modes via `layoutStyle` prop:
 * - Gaming: orbital (cards at corners of a box)
 * - Work: compact grid (2x2 with mic below)
 * - Life: organic dispersed (asymmetric with slight rotations)
 * 
 * Position transitions animate in real-time when switching context.
 */

'use client';

import { Check, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import type { RitualConfig, ContextConfig } from './types';
import { OnboardingTipGuard } from '../onboarding';

interface RitualCardProps {
  ritual: RitualConfig;
  context: ContextConfig['value'];
  isSelected: boolean;
  hasSelection: boolean;
  onSelect: () => void;
  /** Inline positioning styles — driven by parent layout system */
  layoutStyle?: React.CSSProperties;
  /** Sophia suggests this ritual based on emotional context */
  isSuggested?: boolean;
  /** Session is being prepared — show border light streak */
  isPreparing?: boolean;
  /** Compact radial variant — smaller pill with icon + short label */
  compact?: boolean;
}

export function RitualCard({ ritual, context, isSelected, hasSelection, onSelect, layoutStyle, isSuggested, isPreparing, compact }: RitualCardProps) {
  const Icon = ritual.icon;
  const label = ritual.labels[context];
  
  // Show the streak when this card is selected AND session is preparing
  const showStreak = isSelected && isPreparing;

  // Compact radial variant — icon + short label as a rounded pill
  if (compact) {
    return (
      <div
        className={cn(
          'absolute z-10 group transition-all duration-700 ease-in-out',
          isSelected && 'animate-float',
          hasSelection && !isSelected && 'opacity-60',
        )}
        style={{ animationDelay: ritual.floatDelay, ...layoutStyle }}
      >
        <button
          onClick={() => { haptic('light'); onSelect(); }}
          aria-pressed={isSelected}
          data-onboarding={isSuggested ? 'ritual-card-suggested' : `ritual-card-${ritual.type}`}
          className={cn(
            'relative flex items-center gap-2 px-3 py-2.5 rounded-xl text-left transition-all duration-300',
            'bg-sophia-surface',
            'border',
            isSelected
              ? 'border-sophia-purple/50 shadow-lg'
              : 'border-sophia-surface-border hover:border-sophia-purple/30 shadow-soft',
            'hover:shadow-lg hover:-translate-y-0.5',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            isSelected && 'scale-[1.02]',
          )}
        >
          {isSelected && (
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-sophia-purple rounded-full flex items-center justify-center shadow-soft animate-pop-in">
              <Check className="w-2.5 h-2.5 text-white" />
            </div>
          )}
          {isSuggested && !isSelected && (
            <div className="absolute -top-1 -left-1 w-4 h-4 bg-sophia-purple/20 border border-sophia-purple/40 rounded-full flex items-center justify-center shadow-soft animate-pulse">
              <Sparkles className="w-2 h-2 text-sophia-purple" />
            </div>
          )}
          <div className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all',
            isSelected ? 'bg-sophia-purple/15' : 'bg-sophia-surface-border/50',
          )}>
            <Icon className={cn('w-4 h-4', isSelected ? 'text-sophia-purple' : 'text-sophia-text2')} />
          </div>
          <span className={cn(
            'text-sm font-medium leading-tight transition-colors',
            isSelected ? 'text-sophia-purple' : 'text-sophia-text',
          )}>
            {label.title}
          </span>
        </button>
      </div>
    );
  }
  
  return (
    <div 
      className={cn(
        'absolute z-10 group transition-all duration-700 ease-in-out',
        isSelected && 'animate-float',
        hasSelection && !isSelected && 'opacity-60',
      )}
      style={{ 
        animationDelay: ritual.floatDelay,
        ...layoutStyle,
      }}
    >
      {isSuggested && <OnboardingTipGuard tipId="tip-first-ritual-suggestion" isTriggered />}
      {/* Hover lift wrapper */}
      <div className={cn(
        'transition-all duration-300',
        'group-hover:-translate-y-1 group-hover:animate-float-subtle',
      )}>
        {/* Sophia's Embrace glow - uses theme-aware token classes */}
        {isSelected && (
          <>
            <div className="absolute -inset-5 rounded-[2rem] animate-embrace-pulse bg-sophia-purple/10 blur-lg" />
            <div className="absolute -inset-2 rounded-3xl animate-embrace-glow bg-sophia-purple/20 blur-md" />
            <div className="absolute -inset-1 rounded-2xl border border-sophia-purple/50" />
          </>
        )}
        
        {/* ============================================================
            LIGHT STREAK BORDER — runs when session is preparing
            Uses conic-gradient mask trick for the rotating light beam
            ============================================================ */}
        {showStreak && (
          <div 
            className="absolute -inset-[3px] rounded-[20px] overflow-hidden pointer-events-none"
            aria-hidden="true"
          >
            {/* Rotating conic gradient — the "streak" */}
            <div 
              className="absolute inset-0 animate-borderStreak"
              style={{
                background: `conic-gradient(
                  from var(--streak-angle, 0deg) at 50% 50%,
                  transparent 0deg,
                  transparent 240deg,
                  var(--streak-dim) 270deg,
                  var(--streak-mid) 310deg,
                  var(--streak-bright) 340deg,
                  var(--streak-peak) 352deg,
                  var(--streak-bright) 356deg,
                  var(--streak-tail) 360deg
                )`,
              }}
            />
            {/* Outer glow — soft bloom around the streak */}
            <div 
              className="absolute inset-0 animate-borderStreak"
              style={{
                background: `conic-gradient(
                  from var(--streak-angle, 0deg) at 50% 50%,
                  transparent 0deg,
                  transparent 260deg,
                  var(--streak-mid) 320deg,
                  var(--streak-bright) 348deg,
                  var(--streak-mid) 360deg
                )`,
                filter: 'blur(6px)',
                opacity: 0.7,
              }}
            />
            {/* Inner mask — cuts out the center so only the border "ring" is visible */}
            <div 
              className="absolute inset-[3px] rounded-2xl"
              style={{ background: 'var(--card-bg)' }}
            />
          </div>
        )}
        
        <button
          onClick={() => {
            haptic('light');
            onSelect();
          }}
          aria-pressed={isSelected}
          data-onboarding={isSuggested ? 'ritual-card-suggested' : `ritual-card-${ritual.type}`}
          className={cn(
            'relative w-[145px] p-4 rounded-2xl text-left transition-all duration-300',
            'bg-sophia-surface',
            'border',
            isSelected 
              ? 'border-transparent' 
              : 'border-sophia-surface-border hover:border-sophia-purple/30',
            hasSelection && !isSelected
              ? 'shadow-sm'
              : 'shadow-soft',
            'hover:shadow-lg',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            isSelected && 'scale-[1.02]'
          )}
        >
          {/* Selection indicator */}
          {isSelected && (
            <div className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-sophia-purple rounded-full flex items-center justify-center shadow-soft animate-pop-in">
              <Check className="w-3 h-3 text-white" />
            </div>
          )}
          
          {/* Suggested by Sophia indicator */}
          {isSuggested && !isSelected && (
            <div className="absolute -top-1.5 -left-1.5 w-5 h-5 bg-sophia-purple/20 border border-sophia-purple/40 rounded-full flex items-center justify-center shadow-soft animate-pulse">
              <Sparkles className="w-2.5 h-2.5 text-sophia-purple" />
            </div>
          )}
        
          {/* Icon */}
          <div className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center mb-3 transition-all duration-300',
            isSelected 
              ? 'bg-sophia-purple/15' 
              : 'bg-sophia-surface-border/50 group-hover:bg-sophia-purple/5'
          )}>
            <Icon className={cn(
              'w-5 h-5 transition-colors',
              isSelected ? 'text-sophia-purple' : 'text-sophia-text2'
            )} />
          </div>
          
          {/* Text - improved hierarchy */}
          <h3 className={cn(
            'font-semibold text-[15px] leading-tight transition-colors',
            isSelected ? 'text-sophia-purple' : 'text-sophia-text'
          )}>
            {label.title}
          </h3>
          <p className="text-[11px] text-sophia-text2/70 leading-snug mt-1">
            {label.description}
          </p>
        </button>
      </div>
    </div>
  );
}
