/**
 * Resume Banner — Greeting-integrated whisper
 *
 * Instead of a floating card, the resume surface lives inline within
 * the greeting area. Sophia's memory of the last session appears as
 * a poetic whisper: metadata → quote → subtle actions.
 * Cohesive with the Cormorant italic bootstrap-opener treatment.
 */

'use client';

import { useMemo, useCallback, useState } from 'react';
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
  onStartFresh,
  onDismiss,
  className,
}: ResumeBannerProps) {
  const [isDismissing, setIsDismissing] = useState(false);

  const timeAgo = useMemo(() => {
    if (!startedAt) return null;
    return humanizeTime(startedAt, 'relative').text;
  }, [startedAt]);

  const ritualLabel = RITUAL_LABELS[sessionType] || sessionType;
  const contextLabel = CONTEXT_LABELS[contextMode] || contextMode;

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsDismissing(true);
      setTimeout(() => onDismiss?.(), 400);
    },
    [onDismiss],
  );

  return (
    <div
      className={cn(
        'group relative mx-auto mt-5 max-w-md text-center',
        'transition-all duration-500 ease-out',
        isDismissing
          ? 'translate-y-1 scale-[0.98] opacity-0'
          : 'translate-y-0 scale-100 opacity-100',
        className,
      )}
      role="region"
      aria-label="Resume previous session"
    >
      {/* Metadata — tiny whispered context */}
      <p className="text-[10px] font-normal uppercase tracking-[0.1em] text-black/28 dark:text-white/18">
        {contextLabel} · {ritualLabel}
        {timeAgo && <> · {timeAgo}</>}
      </p>

      {/* Quote — the emotional anchor, clickable to resume */}
      <button
        type="button"
        onClick={onResume}
        className={cn(
          'mt-1.5 inline-block max-w-sm cursor-pointer rounded-sm',
          'transition-colors duration-300',
          'hover:text-black/52 dark:hover:text-white/40',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sophia-purple)] focus-visible:ring-offset-4 focus-visible:ring-offset-transparent',
        )}
      >
        <span className="font-cormorant text-[15px] font-light italic leading-relaxed text-black/36 dark:text-white/26">
          {lastMessagePreview ? (
            <>&ldquo;{lastMessagePreview}&rdquo;</>
          ) : (
            <>&ldquo;You left something unfinished&hellip;&rdquo;</>
          )}
        </span>
      </button>

      {/* Actions — minimal, text-only */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        <button
          type="button"
          onClick={onResume}
          className={cn(
            'rounded-full px-3.5 py-1 text-[11px] font-medium tracking-[0.03em]',
            'text-[rgba(var(--sophia-glow-rgb,124,92,170),0.72)]',
            'border border-[rgba(var(--sophia-glow-rgb,124,92,170),0.12)]',
            'bg-[rgba(var(--sophia-glow-rgb,124,92,170),0.04)]',
            'transition-all duration-300',
            'hover:border-[rgba(var(--sophia-glow-rgb,124,92,170),0.22)] hover:bg-[rgba(var(--sophia-glow-rgb,124,92,170),0.08)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sophia-purple)]',
          )}
        >
          continue
        </button>
        <span className="text-[10px] text-black/12 dark:text-white/8">·</span>
        <button
          type="button"
          onClick={onStartFresh}
          className={cn(
            'rounded-full px-3 py-1 text-[11px] font-normal tracking-[0.02em]',
            'text-black/25 dark:text-white/16',
            'transition-colors duration-300',
            'hover:text-black/42 dark:hover:text-white/32',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sophia-purple)]',
          )}
        >
          start fresh
        </button>
      </div>

      {/* Dismiss — ghost, appears on group hover */}
      {onDismiss && (
        <button
          type="button"
          onClick={handleDismiss}
          className={cn(
            'absolute -right-3 -top-1 flex h-5 w-5 items-center justify-center rounded-full',
            'text-black/0 transition-all duration-300',
            'group-hover:text-black/18 hover:!text-black/40 hover:!bg-black/[0.04]',
            'dark:text-white/0 dark:group-hover:text-white/12 dark:hover:!text-white/35 dark:hover:!bg-white/[0.04]',
            'focus:outline-none focus-visible:text-black/40 dark:focus-visible:text-white/35',
          )}
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
