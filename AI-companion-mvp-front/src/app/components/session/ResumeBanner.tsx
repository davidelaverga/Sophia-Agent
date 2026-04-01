/**
 * Resume Banner
 * Sprint 1+ - "Welcome back" UX for session continuity
 * 
 * Premium, scannable banner for session resumption.
 * Structure: [Icon + Label + Meta] [Preview] [Actions]
 * 
 * Replaced hardcoded UI values with Sophia theme tokens
 */

'use client';

import { useMemo } from 'react';
import { X, ArrowRight, Play } from 'lucide-react';
import { cn } from '../../lib/utils';
import { humanizeTime } from '../../lib/humanize-time';
import type { PresetType } from '../../lib/session-types';

interface ResumeBannerProps {
  /** Type of the paused session */
  sessionType: PresetType;
  /** Context mode (gaming/work/life) */
  contextMode?: 'gaming' | 'work' | 'life';
  /** How long ago the session started */
  startedAt?: string;
  /** Number of messages in the session */
  messageCount?: number;
  /** Preview of the last message */
  lastMessagePreview?: string;
  /** Resume the existing session */
  onResume: () => void;
  /** Start a new session (discards old one) */
  onStartFresh: () => void;
  /** Dismiss the banner without action */
  onDismiss?: () => void;
  /** Additional CSS classes */
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
  // Humanize the time
  const timeAgo = useMemo(() => {
    if (!startedAt) return null;
    return humanizeTime(startedAt, 'relative').text;
  }, [startedAt]);
  
  const ritualLabel = RITUAL_LABELS[sessionType] || sessionType;
  const contextLabel = CONTEXT_LABELS[contextMode] || contextMode;

  return (
    <div
      className={cn(
        'relative flex items-center gap-4 px-4 py-3 rounded-2xl',
        'bg-sophia-surface',
        'border border-sophia-surface-border',
        'shadow-soft',
        'animate-fadeIn',
        'motion-reduce:animate-none',
        className
      )}
      role="region"
      aria-label="Resume session banner"
    >
      {/* LEFT: Icon + Label + Meta */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Icon container */}
        <div className="w-10 h-10 rounded-xl bg-sophia-purple/10 flex items-center justify-center">
          <Play className="w-4 h-4 text-sophia-purple ml-0.5" />
        </div>
        
        {/* Label & metadata */}
        <div className="hidden sm:block">
          <p className="text-xs font-medium text-sophia-text">
            Resume session
          </p>
          <p className="text-[11px] text-sophia-text2 mt-0.5">
            {contextLabel} · {ritualLabel}
            {timeAgo && ` · ${timeAgo}`}
          </p>
        </div>
      </div>

      {/* MIDDLE: Preview (truncated) or spacer */}
      {lastMessagePreview ? (
        <div className="flex-1 min-w-0 hidden md:block">
          <p className="text-[13px] text-sophia-text2/80 truncate italic">
            &ldquo;{lastMessagePreview}&rdquo;
          </p>
        </div>
      ) : (
        <div className="flex-1 hidden sm:block" />
      )}
      
      {/* Mobile: Compact label */}
      <div className="flex-1 min-w-0 sm:hidden">
        <p className="text-sm text-sophia-text truncate">
          Resume {ritualLabel.toLowerCase()}
          {timeAgo && <span className="text-sophia-text2"> · {timeAgo}</span>}
        </p>
      </div>

      {/* RIGHT: Actions */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Primary: Continue */}
        <button
          onClick={onResume}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium',
            'bg-sophia-purple text-white',
            'hover:opacity-90 active:scale-[0.98]',
            'transition-all duration-150',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2 focus-visible:ring-offset-sophia-bg'
          )}
        >
          Continue
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        
        {/* Dismiss (minimal) */}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className={cn(
              'p-1.5 rounded-lg',
              'text-sophia-text2/40 hover:text-sophia-text2',
              'hover:bg-sophia-button-hover',
              'transition-all duration-150',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
            )}
            aria-label="Dismiss banner"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// COMPACT VARIANT (pill style for minimal intrusion)
// =============================================================================

interface CompactResumeBannerProps {
  sessionType: PresetType;
  onResume: () => void;
  className?: string;
}

export function CompactResumeBanner({
  sessionType,
  onResume,
  className,
}: CompactResumeBannerProps) {
  const ritualLabel = RITUAL_LABELS[sessionType] || sessionType;

  return (
    <button
      onClick={onResume}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-full',
        'bg-sophia-purple/10 text-sophia-purple text-xs font-medium',
        'hover:bg-sophia-purple/20 active:scale-[0.97]',
        'transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
        className
      )}
    >
      <Play className="w-3 h-3" />
      <span>Continue {ritualLabel.toLowerCase()}</span>
      <ArrowRight className="w-3 h-3" />
    </button>
  );
}

