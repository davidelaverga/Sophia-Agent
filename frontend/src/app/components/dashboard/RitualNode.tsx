'use client';

import { useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';
import type { ContextMode } from '../../types/session';

import { useSweepGlow } from './sweepLight';
import type { RitualConfig } from './types';

interface RitualNodeProps {
  ritual: RitualConfig;
  context: ContextMode;
  isSelected: boolean;
  isSuggested?: boolean;
  isPreparing?: boolean;
  /** CSS position (top/left/right/bottom only — no transform) */
  positionCSS?: React.CSSProperties;
  /** Centering translate, e.g. 'translateX(-50%)' or 'translateY(-50%)' */
  baseTransform?: string;
  onSelect: () => void;
  /** Node has been revealed (entrance / re-reveal after switch) */
  revealed?: boolean;
  /** Switching context — instant collapse */
  switching?: boolean;
  /** Stagger delay in seconds (0.6, 0.75, 0.9, 1.05 per prototype) */
  staggerDelay?: number;
}

export function RitualNode({
  ritual,
  context,
  isSelected,
  isSuggested = false,
  isPreparing = false,
  positionCSS,
  baseTransform = '',
  onSelect,
  revealed = true,
  switching = false,
  staggerDelay = 0,
}: RitualNodeProps) {
  const [isActive, setIsActive] = useState(false);
  const sweepRef = useSweepGlow();
  const Icon = ritual.icon;
  const label = ritual.labels[context];
  const showDescription = isSelected || isActive;

  return (
    <button
      type="button"
      data-ritual={ritual.type}
      aria-pressed={isSelected}
      onClick={() => {
        haptic('light');
        onSelect();
      }}
      onFocus={() => setIsActive(true)}
      onBlur={() => setIsActive(false)}
      onMouseEnter={() => setIsActive(true)}
      onMouseLeave={() => setIsActive(false)}
      className={cn(
        'absolute z-20 flex flex-col items-center gap-[6px] outline-none',
        // ALWAYS keep transition defined so the browser can animate between states.
        // Switching = fast collapse; everything else = slow slide-in.
        switching
          ? 'transition-[opacity,transform] duration-[0.25s] ease-out'
          : 'transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]',
        // Opacity: visible only when revealed and not switching
        revealed && !switching ? 'opacity-100' : 'opacity-0',
        isPreparing && isSelected && 'animate-pulse',
      )}
      style={{
        ...positionCSS,
        // Switching → drop centering translate, scale(0.9) → nodes drift outward
        // Revealed → restore centering translate + scale(1) → nodes slide into position
        // Hidden  → drop centering translate, scale(0.85) → starting offset for first entrance
        transform: switching
          ? 'scale(0.9)'
          : revealed
            ? `${baseTransform} scale(${isSelected ? 1.06 : 1})`
            : 'scale(0.85)',
        transitionDelay: revealed && !switching ? `${staggerDelay}s` : '0s',
      }}
    >
      <span
        ref={sweepRef as React.RefObject<HTMLSpanElement>}
        className={cn(
          'cosmic-surface-panel relative flex h-[50px] w-[50px] items-center justify-center rounded-full transition-all duration-300'
        )}
        style={{
          ...(isSelected ? { borderColor: 'var(--cosmic-border-strong)' } : {}),
          filter: 'brightness(calc(1 + var(--sweep-glow, 0) * 0.15))',
          boxShadow: isSelected
            ? '0 0 32px color-mix(in srgb, var(--sophia-purple) 22%, transparent)'
            : [
                // Cast shadow — away from the light, depth scales with proximity
                'calc((8px + 4px * var(--sweep-proximity, 0)) * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
                'calc((8px + 4px * var(--sweep-proximity, 0)) * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
                'calc((12px + 6px * var(--sweep-proximity, 0)) * var(--sweep-glow, 0))',
                '0px',
                'rgba(0, 0, 0, calc(var(--sweep-glow, 0) * 0.22))',
              ].join(' ') + ', ' +
              [
                // Lit edge — glow on the light-facing side
                'calc(-3px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
                'calc(-3px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
                'calc(8px * var(--sweep-glow, 0))',
                'calc(2px * var(--sweep-glow, 0))',
                'rgba(200, 180, 255, calc(var(--sweep-glow, 0) * 0.18))',
              ].join(' ') + ', ' +
              [
                // Inner highlight — soft center glow when lit
                'inset',
                'calc(-2px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
                'calc(-2px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
                'calc(6px * var(--sweep-glow, 0))',
                '0px',
                'rgba(220, 200, 255, calc(var(--sweep-glow, 0) * 0.08))',
              ].join(' '),
        }}
      >
        {isSuggested && !isSelected && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--sophia-glow)] shadow-[0_0_10px_var(--sophia-glow)]" />
        )}
        <Icon
          className={cn(
            'h-5 w-5 transition-colors duration-300',
          )}
          style={{ color: isSelected ? 'var(--sophia-purple)' : showDescription ? 'var(--cosmic-text)' : 'var(--cosmic-text-muted)' }}
        />
      </span>

      <span className="whitespace-nowrap text-[11px] font-normal tracking-[0.05em]" style={{ color: isSelected ? 'var(--cosmic-text)' : 'var(--cosmic-text-whisper)' }}>
        {label.title}
      </span>

      <span
        data-visible={showDescription ? 'true' : 'false'}
        className={cn(
          'whitespace-nowrap text-[10px] font-light leading-snug transition-all duration-300',
          showDescription ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        )}
        style={{ color: 'var(--cosmic-text-whisper)' }}
      >
        {label.description}
      </span>
    </button>
  );
}