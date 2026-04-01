/**
 * ContextTabs Component
 * Tab selector for context mode (Gaming, Work, Life)
 */

'use client';

import { useRef, useCallback } from 'react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import { CONTEXTS } from './types';
import type { ContextMode } from '../../types/session';

interface ContextTabsProps {
  selected: ContextMode;
  onSelect: (context: ContextMode) => void;
}

export function ContextTabs({ selected, onSelect }: ContextTabsProps) {
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex: number | null = null;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = (index + 1) % CONTEXTS.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = (index - 1 + CONTEXTS.length) % CONTEXTS.length;
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextIndex = CONTEXTS.length - 1;
      }

      if (nextIndex !== null) {
        tabsRef.current[nextIndex]?.focus();
        haptic('light');
        onSelect(CONTEXTS[nextIndex].value);
      }
    },
    [onSelect]
  );

  return (
    <div
      role="tablist"
      aria-label="Context mode"
      className="inline-flex items-center gap-1 p-1 rounded-full bg-sophia-surface border border-sophia-surface-border dark:shadow-[0_2px_20px_color-mix(in_srgb,var(--sophia-purple)_10%,transparent)]"
    >
      {CONTEXTS.map((ctx, index) => {
        const Icon = ctx.icon;
        const isActive = selected === ctx.value;
        
        return (
          <button
            key={ctx.value}
            ref={(el) => { tabsRef.current[index] = el; }}
            data-onboarding={`preset-tab-${ctx.value}`}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              haptic('light');
              onSelect(ctx.value);
            }}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-1 focus-visible:ring-offset-sophia-surface',
              isActive 
                ? 'bg-sophia-button text-sophia-text shadow-md dark:shadow-[0_2px_12px_color-mix(in_srgb,var(--sophia-purple)_25%,transparent)]' 
                : 'text-sophia-text2 hover:text-sophia-text'
            )}
          >
            <Icon className="w-4 h-4" />
            {ctx.label}
          </button>
        );
      })}
    </div>
  );
}
