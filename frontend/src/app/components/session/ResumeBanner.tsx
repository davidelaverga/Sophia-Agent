/**
 * Resume Banner — Greeting-integrated whisper
 *
 * Instead of a floating card, the resume surface lives inline within
 * the greeting area. Sophia's memory of the last session appears as
 * a poetic whisper: metadata → quote → subtle actions.
 * Cohesive with the Cormorant italic bootstrap-opener treatment.
 */

'use client';

import { X } from 'lucide-react';
import { useMemo, useCallback, useState } from 'react';

import { humanizeTime } from '../../lib/humanize-time';
import type { PresetType } from '../../lib/session-types';
import { cn } from '../../lib/utils';

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
      <p className="text-[10px] font-normal uppercase tracking-[0.1em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
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
          'cosmic-focus-ring hover:text-[var(--cosmic-text)]',
        )}
      >
        <span className="font-cormorant text-[15px] font-light italic leading-relaxed" style={{ color: 'var(--cosmic-text-muted)' }}>
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
            'cosmic-accent-pill cosmic-focus-ring rounded-full px-3.5 py-1 text-[11px] font-medium tracking-[0.03em] transition-all duration-300',
          )}
        >
          continue
        </button>
        <span className="text-[10px]" style={{ color: 'var(--cosmic-text-faint)' }}>·</span>
        <button
          type="button"
          onClick={onStartFresh}
          className={cn(
            'cosmic-whisper-button cosmic-focus-ring rounded-full px-3 py-1 text-[11px] font-normal tracking-[0.02em] transition-colors duration-300',
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
            'cosmic-focus-ring text-transparent transition-all duration-300',
            'group-hover:text-[var(--cosmic-text-whisper)] hover:!text-[var(--cosmic-text)] hover:!bg-[var(--cosmic-panel-soft)]',
            'focus-visible:text-[var(--cosmic-text)]',
          )}
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
