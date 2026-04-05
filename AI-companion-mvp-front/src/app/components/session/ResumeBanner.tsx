/**
 * Resume Banner
 * Compact horizontal banner matching the prototype exactly:
 * [▶ play circle] [context · ritual · time  +  opener quote] [× dismiss]
 * Position: top-left, glass surface, small and unobtrusive.
 */

'use client';

import { useMemo, useCallback } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { humanizeTime } from '../../lib/humanize-time';
import type { PresetType } from '../../lib/session-types';

interface ResumeBannerProps {
  sessionType: PresetType;
  contextMode?: 'gaming' | 'work' | 'life';
  startedAt?: string;
  messageCount?: number;
  lastMessagePreview?: string;
  onResume: () => void;
  onStartFresh: () => void;
  onDismiss?: () => void;
  className?: string;
}

const RITUAL_LABELS: Record<PresetType, string> = {
  prepare: 'Pre-game',
  debrief: 'Post-game',
  reset: 'Reset',
  vent: 'Vent',
  open: 'Open',
  chat: 'Chat',
};

const CONTEXT_LABELS: Record<string, string> = {
  gaming: 'Gaming',
  work: 'Work',
  life: 'Life',
};

export function ResumeBanner({
  sessionType,
  contextMode = 'gaming',
  startedAt,
  messageCount: _messageCount,
  lastMessagePreview,
  onResume,
  onStartFresh: _onStartFresh,
  onDismiss,
  className,
}: ResumeBannerProps) {
  const timeAgo = useMemo(() => {
    if (!startedAt) return null;
    return humanizeTime(startedAt, 'relative').text;
  }, [startedAt]);
  
  const ritualLabel = RITUAL_LABELS[sessionType] || sessionType;
  const contextLabel = CONTEXT_LABELS[contextMode] || contextMode;

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss?.();
  }, [onDismiss]);

  return (
    <button
      type="button"
      onClick={onResume}
      className={cn(
        'group flex w-full max-w-[380px] items-center gap-3 rounded-[14px] px-3 py-2.5 text-left',
        'border backdrop-blur-[20px] transition-all duration-300',
        'border-black/[0.06] bg-white/60',
        'dark:border-white/[0.04] dark:bg-[rgba(8,8,18,0.45)]',
        'hover:border-black/[0.12] dark:hover:border-white/[0.12]',
        'cursor-pointer',
        'animate-fadeIn motion-reduce:animate-none',
        className
      )}
      role="region"
      aria-label="Resume previous session"
    >
      {/* Play circle */}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[rgba(var(--sophia-glow-rgb,124,92,170),0.2)] bg-[rgba(var(--sophia-glow-rgb,124,92,170),0.12)]">
        <svg viewBox="0 0 24 24" className="ml-[1px] h-2.5 w-2.5 fill-[rgba(var(--sophia-glow-rgb,124,92,170),0.7)]" aria-hidden="true">
          <polygon points="8,5 19,12 8,19" />
        </svg>
      </span>

      {/* Meta */}
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[9px] font-normal uppercase tracking-[0.08em] text-black/40 dark:text-white/28">
          {contextLabel} · {ritualLabel}
          {timeAgo && ` · ${timeAgo}`}
        </span>
        {lastMessagePreview ? (
          <span className="truncate font-cormorant text-[13px] font-light italic text-black/40 dark:text-white/28">
            &ldquo;{lastMessagePreview}&rdquo;
          </span>
        ) : (
          <span className="truncate font-cormorant text-[13px] font-light italic text-black/40 dark:text-white/28">
            &ldquo;Tap to continue where you left off&rdquo;
          </span>
        )}
      </span>

      {/* Dismiss */}
      {onDismiss && (
        <span
          role="button"
          tabIndex={0}
          onClick={handleDismiss}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleDismiss(e as unknown as React.MouseEvent); } }}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
            'text-black/15 transition-colors duration-200',
            'hover:bg-black/[0.04] hover:text-black/40',
            'dark:text-white/15 dark:hover:bg-white/[0.04] dark:hover:text-white/40',
          )}
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  );
}
