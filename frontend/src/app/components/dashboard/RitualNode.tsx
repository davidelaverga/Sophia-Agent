'use client';

import { useState } from 'react';

import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import type { ContextMode } from '../../types/session';

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
        className={cn(
          'relative flex h-[50px] w-[50px] items-center justify-center rounded-full border backdrop-blur-xl transition-all duration-300',
          'bg-white/92 border-black/10 shadow-[0_10px_30px_rgba(0,0,0,0.08)]',
          'dark:bg-white/[0.06] dark:border-white/[0.08] dark:shadow-[0_12px_40px_rgba(0,0,0,0.35)]',
          isSelected && 'border-black/20 shadow-[0_14px_40px_rgba(0,0,0,0.12)] dark:border-white/[0.16] dark:shadow-[0_0_32px_rgba(124,92,170,0.22)]'
        )}
      >
        {isSuggested && !isSelected && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--sophia-glow)] shadow-[0_0_10px_var(--sophia-glow)]" />
        )}
        <Icon
          className={cn(
            'h-5 w-5 transition-colors duration-300',
            isSelected ? 'text-[var(--sophia-purple)]' : 'text-black/45 dark:text-white/55',
            showDescription && !isSelected && 'text-black/60 dark:text-white/72'
          )}
        />
      </span>

      <span className={cn('whitespace-nowrap text-[11px] font-normal tracking-[0.05em]', isSelected ? 'text-black/65 dark:text-white/65' : 'text-black/28 dark:text-white/28')}>
        {label.title}
      </span>

      <span
        data-visible={showDescription ? 'true' : 'false'}
        className={cn(
          'whitespace-nowrap text-[10px] font-light leading-snug text-black/28 transition-all duration-300 dark:text-white/22',
          showDescription ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        )}
      >
        {label.description}
      </span>
    </button>
  );
}