/**
 * ContextTabs Component
 * Tab selector for context mode (Gaming, Work, Life)
 */

'use client';

import { useRef, useCallback } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';
import type { ContextMode } from '../../types/session';

import { CONTEXTS } from './types';

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
    <div className="flex flex-col items-center gap-2">
      <div
        role="tablist"
        aria-label="Context mode"
        className="cosmic-surface-panel inline-flex items-center gap-1 rounded-full p-1.5"
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
                'cosmic-focus-ring',
                isActive ? 'shadow-md' : ''
              )}
              style={isActive ? {
                background: 'color-mix(in srgb, var(--text) 6%, transparent)',
                color: 'var(--cosmic-text-strong)',
                boxShadow: '0 2px 12px color-mix(in srgb, var(--sophia-purple) 25%, transparent)',
              } : {
                color: 'var(--cosmic-text-muted)',
              }}
            >
              <Icon className="w-4 h-4" />
              {ctx.label}
            </button>
          );
        })}
      </div>

      {/* Context hint */}
      <p
        className="text-[11px] font-normal tracking-[0.05em]"
        style={{
          color: 'color-mix(in srgb, var(--cosmic-text-muted) 78%, var(--text) 22%)',
          textShadow: '0 1px 10px color-mix(in srgb, var(--background) 82%, transparent)',
        }}
      >
        adapts rituals &amp; tone to your context
      </p>
    </div>
  );
}
