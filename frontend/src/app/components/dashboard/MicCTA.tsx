/**
 * MicCTA Component
 * Center mic — matches the prototype's .center-mic exactly:
 * 88px outer, 3 breathing rings, 60px glass core, status dot, label below.
 */

'use client';

import { Mic, Square } from 'lucide-react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';
import type { PresetType, ContextMode } from '../../types/session';

import { RITUALS, type MicState } from './types';

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
      className="group flex flex-col items-center gap-[10px]"
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
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
          style={{ borderColor: isActive ? 'var(--cosmic-border)' : 'var(--cosmic-border-soft)' }}
        />
        <span
          className={cn(
            'absolute inset-[-10px] rounded-full border transition-colors duration-1000',
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
          style={{
            borderColor: isActive ? 'var(--cosmic-border)' : 'var(--cosmic-border-soft)',
            animationDelay: isActive ? '0.3s' : '0.8s',
          }}
        />
        <span
          className={cn(
            'absolute inset-[-20px] rounded-full border transition-colors duration-1000',
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
          style={{
            borderColor: isActive ? 'var(--cosmic-border)' : 'var(--cosmic-border-soft)',
            animationDelay: isActive ? '0.6s' : '1.6s',
          }}
        />

        {/* mic-core — 60×60 glass circle */}
        <span
          className={cn(
            'cosmic-surface-panel relative z-10 flex h-[60px] w-[60px] items-center justify-center rounded-full transition-all duration-500',
          )}
          style={isActive ? {
            background: 'color-mix(in srgb, var(--sophia-purple) 5%, var(--cosmic-panel-strong))',
            borderColor: 'var(--cosmic-border-strong)',
            boxShadow: '0 0 60px color-mix(in srgb, var(--sophia-purple) 14%, transparent), inset 0 0 25px color-mix(in srgb, var(--sophia-purple) 6%, transparent)',
          } : selectedRitual ? {
            borderColor: 'var(--cosmic-border)',
            boxShadow: '0 0 40px color-mix(in srgb, var(--sophia-purple) 12%, transparent)',
          } : undefined}
        >
          {/* Status dot — top-right */}
          <span
            className={cn(
              'absolute right-[2px] top-[2px] z-20 h-2 w-2 rounded-full transition-all duration-500',
              isActive ? 'animate-pulse' : '',
            )}
            style={isActive ? {
              background: 'var(--sophia-purple)',
              boxShadow: '0 0 10px color-mix(in srgb, var(--sophia-purple) 40%, transparent)',
            } : {
              background: 'color-mix(in srgb, var(--cosmic-teal) 70%, transparent)',
              boxShadow: '0 0 8px color-mix(in srgb, var(--cosmic-teal) 30%, transparent)',
            }}
          />

          {/* Icon — mic or stop */}
          {isActive && micState !== 'idle' ? (
            <Square className="h-[22px] w-[22px] stroke-[1.5]" style={{ color: 'var(--sophia-purple)' }} />
          ) : (
            <Mic
              className={cn(
                'h-[22px] w-[22px] stroke-[1.5] transition-colors duration-300',
                isActive ? '' : 'group-hover:text-[var(--cosmic-text)]',
              )}
              style={{ color: isActive ? 'var(--sophia-purple)' : 'var(--cosmic-text-muted)' }}
            />
          )}
        </span>
      </div>

      {/* Label — prototype: .mic-label */}
      <span
        className={cn(
          'min-h-[14px] text-center text-[10px] lowercase tracking-[0.12em] transition-colors duration-500',
        )}
        style={{ color: isActive ? 'color-mix(in srgb, var(--sophia-purple) 50%, transparent)' : 'var(--cosmic-text-faint)' }}
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
