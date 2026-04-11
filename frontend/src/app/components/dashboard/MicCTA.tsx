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

import { useSweepGlow } from './sweepLight';
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
  const sweepRef = useSweepGlow();

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
        ref={sweepRef as React.RefObject<HTMLDivElement>}
        data-onboarding="mic-cta"
        className={cn(
          'relative flex h-[88px] w-[88px] items-center justify-center rounded-full transition-transform duration-300',
          'cursor-pointer hover:scale-[1.04]',
          isStartingSession && 'cursor-wait',
        )}
        style={{
          filter: 'brightness(calc(1 + var(--sweep-glow, 0) * 0.18))',
          boxShadow: [
            // Cast shadow — away from the light, deeper when closer
            'calc((10px + 6px * var(--sweep-proximity, 0)) * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
            'calc((10px + 6px * var(--sweep-proximity, 0)) * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
            'calc((16px + 8px * var(--sweep-proximity, 0)) * var(--sweep-glow, 0))',
            '0px',
            'rgba(0, 0, 0, calc(var(--sweep-glow, 0) * 0.28))',
          ].join(' ') + ', ' +
          [
            // Lit edge — glow on the light-facing side
            'calc(-4px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
            'calc(-4px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
            'calc(10px * var(--sweep-glow, 0))',
            'calc(2px * var(--sweep-glow, 0))',
            'rgba(200, 180, 255, calc(var(--sweep-glow, 0) * 0.22))',
          ].join(' ') + ', ' +
          [
            // Inner highlight — directional light catching inside the button
            'inset',
            'calc(-3px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
            'calc(-3px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
            'calc(8px * var(--sweep-glow, 0))',
            '0px',
            'rgba(220, 200, 255, calc(var(--sweep-glow, 0) * 0.10))',
          ].join(' '),
        }}
      >
        {/* Breathing rings — prototype: inset 0 / -10px / -20px */}
        <span
          className={cn(
            'absolute inset-0 rounded-full border transition-colors duration-1000',
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
          style={{
            borderColor: isActive ? 'var(--cosmic-border)' : 'var(--cosmic-border-soft)',
            boxShadow: [
              'calc(-2px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
              'calc(-2px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
              'calc(6px * var(--sweep-glow, 0))',
              '0px',
              'rgba(200, 180, 255, calc(var(--sweep-glow, 0) * 0.12))',
            ].join(' '),
          }}
        />
        <span
          className={cn(
            'absolute inset-[-10px] rounded-full border transition-colors duration-1000',
            isActive ? 'animate-mic-active-breathe' : 'animate-mic-breathe',
          )}
          style={{
            borderColor: isActive ? 'var(--cosmic-border)' : 'var(--cosmic-border-soft)',
            animationDelay: isActive ? '0.3s' : '0.8s',
            boxShadow: [
              'calc(-2px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
              'calc(-2px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
              'calc(5px * var(--sweep-glow, 0))',
              '0px',
              'rgba(200, 180, 255, calc(var(--sweep-glow, 0) * 0.08))',
            ].join(' '),
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
            boxShadow: [
              'calc(-2px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
              'calc(-2px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
              'calc(4px * var(--sweep-glow, 0))',
              '0px',
              'rgba(200, 180, 255, calc(var(--sweep-glow, 0) * 0.05))',
            ].join(' '),
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
