/**
 * MicCTA Component
 * Center mic — matches the prototype's .center-mic exactly:
 * 88px outer, 3 breathing rings, 60px glass core, status dot, label below.
 */

'use client';

import { Mic, Square } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import { RITUALS, type MicState } from './types';
import type { PresetType, ContextMode } from '../../types/session';

interface MicCTAProps {
  selectedRitual: PresetType | null;
  context: ContextMode;
  micState: MicState;
  isOffline?: boolean;
  isConnecting?: boolean;
  isStartingSession?: boolean;
  onCall: () => void;
  onContinue: () => void;
}

export function MicCTA({
  selectedRitual,
  context,
  micState,
  isOffline: _isOffline,
  isConnecting: _isConnecting,
  isStartingSession = false,
  onCall,
  onContinue: _onContinue,
}: MicCTAProps) {
  const ritualLabel = selectedRitual
    ? RITUALS.find((r) => r.type === selectedRitual)?.labels[context].title
    : null;

  const isActive = micState !== 'idle' || isStartingSession;

  return (
    <div
      className="flex flex-col items-center gap-[10px]"
      role="button"
      tabIndex={0}
      onClick={() => {
        if (isStartingSession) return;
        haptic('medium');
        onCall();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!isStartingSession) {
            haptic('medium');
            onCall();
          }
        }
      }}
      aria-label={
        isStartingSession
          ? 'Connecting to Sophia'
          : micState === 'listening'
            ? 'Stop listening'
            : micState === 'thinking'
              ? 'Sophia is processing'
              : micState === 'speaking'
                ? 'Interrupt Sophia'
                : selectedRitual
                  ? `Start ${ritualLabel?.toLowerCase() ?? 'session'}`
                  : 'Talk to Sophia'
      }
    >
      {/* mic-outer — 88×88, contains rings + core */}
      <div
        data-onboarding="mic-cta"
        className={cn(
          'relative flex h-[88px] w-[88px] items-center justify-center transition-transform duration-300',
          'cursor-pointer hover:scale-[1.04]',
          isStartingSession && 'cursor-wait',
        )}
      >
        {/* Breathing rings — prototype: inset 0 / -10px / -20px */}
        <span
          className={cn(
            'absolute inset-0 rounded-full border transition-colors duration-1000',
            'border-black/[0.04] dark:border-white/[0.04]',
            isActive && 'border-[rgba(var(--sophia-glow-rgb,124,92,170),0.1)]',
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
        />
        <span
          className={cn(
            'absolute inset-[-10px] rounded-full border transition-colors duration-1000',
            'border-black/[0.04] dark:border-white/[0.04]',
            isActive && 'border-[rgba(var(--sophia-glow-rgb,124,92,170),0.1)]',
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
          style={{ animationDelay: isActive ? '0.3s' : '0.8s' }}
        />
        <span
          className={cn(
            'absolute inset-[-20px] rounded-full border transition-colors duration-1000',
            'border-black/[0.04] dark:border-white/[0.04]',
            isActive && 'border-[rgba(var(--sophia-glow-rgb,124,92,170),0.1)]',
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
          style={{ animationDelay: isActive ? '0.6s' : '1.6s' }}
        />

        {/* mic-core — 60×60 glass circle */}
        <span
          className={cn(
            'relative z-10 flex h-[60px] w-[60px] items-center justify-center rounded-full backdrop-blur-[20px] transition-all duration-500',
            'border bg-white/60 border-black/[0.06]',
            'dark:bg-[rgba(8,8,18,0.45)] dark:border-white/[0.04]',
            // hover glow
            'group-hover:border-[rgba(124,92,170,0.18)] group-hover:shadow-[0_0_50px_rgba(124,92,170,0.08),inset_0_0_20px_rgba(124,92,170,0.04)]',
            // active glow
            isActive && 'border-[rgba(124,92,170,0.28)] bg-[rgba(124,92,170,0.05)] shadow-[0_0_60px_rgba(124,92,170,0.12),inset_0_0_25px_rgba(124,92,170,0.06)]',
            // selected ritual glow
            selectedRitual && !isActive && 'border-[rgba(124,92,170,0.18)] shadow-[0_0_40px_rgba(124,92,170,0.12)]',
          )}
        >
          {/* Status dot — top-right */}
          <span
            className={cn(
              'absolute right-[2px] top-[2px] z-20 h-2 w-2 rounded-full transition-all duration-500',
              isActive
                ? 'bg-[rgba(124,92,170,0.8)] shadow-[0_0_10px_rgba(124,92,170,0.4)] animate-pulse'
                : 'bg-[rgba(72,199,142,0.7)] shadow-[0_0_8px_rgba(72,199,142,0.3)]',
            )}
          />

          {/* Icon — mic or stop */}
          {isActive && micState !== 'idle' ? (
            <Square className="h-[22px] w-[22px] stroke-[1.5] text-[rgba(124,92,170,0.85)]" />
          ) : (
            <Mic
              className={cn(
                'h-[22px] w-[22px] stroke-[1.5] transition-colors duration-300',
                'text-black/35 dark:text-white/35',
                isActive && 'text-[rgba(124,92,170,0.85)]',
              )}
            />
          )}
        </span>
      </div>

      {/* Label — prototype: .mic-label */}
      <span
        className={cn(
          'min-h-[14px] text-center text-[10px] lowercase tracking-[0.12em] transition-colors duration-500',
          isActive
            ? 'text-[rgba(124,92,170,0.5)]'
            : 'text-black/[0.08] dark:text-white/[0.08]',
        )}
        role="status"
        aria-live="polite"
      >
        {isStartingSession
          ? 'connecting...'
          : micState === 'listening'
            ? 'listening...'
            : micState === 'thinking'
              ? 'processing...'
              : micState === 'speaking'
                ? 'sophia is here'
                : ritualLabel
                  ? `start ${ritualLabel.toLowerCase()}`
                  : 'tap to talk'}
      </span>
    </div>
  );
}
