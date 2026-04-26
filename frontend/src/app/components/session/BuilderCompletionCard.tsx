'use client';

import { useMemo, type MouseEventHandler } from 'react';

import { cn } from '../../lib/utils';
import type { BuilderCompletionEventV1 } from '../../types/builder-completion';

type StatusMeta = {
  label: string;
  accentVar: string;
  icon: 'check' | 'warn' | 'pause';
};

const STATUS_META: Record<BuilderCompletionEventV1['status'], StatusMeta> = {
  success:   { label: 'ready',     accentVar: 'var(--cosmic-teal)',                   icon: 'check' },
  error:     { label: 'failed',    accentVar: 'var(--sophia-error, #f87171)',         icon: 'warn'  },
  timeout:   { label: 'timed out', accentVar: 'var(--cosmic-amber)',                  icon: 'warn'  },
  cancelled: { label: 'cancelled', accentVar: 'var(--cosmic-text-faint, #a1a1aa)',    icon: 'pause' },
};

const FAILURE_BODY =
  'Sorry it seems like the task didn’t complete. Do you want me to try again?';
const TIMEOUT_BODY =
  'The build took longer than expected and was cut short. Want me to try again?';
const CANCELLED_BODY = 'Build was cancelled. Let me know when you want to pick it up again.';

type BuilderCompletionCardProps = {
  event: BuilderCompletionEventV1;
  onOpen?: (event: BuilderCompletionEventV1) => void;
  onRetry?: (event: BuilderCompletionEventV1) => void;
  onDismiss?: (event: BuilderCompletionEventV1) => void;
  compact?: boolean;
  className?: string;
};

function StatusGlyph({ icon, accentVar, compact }: { icon: StatusMeta['icon']; accentVar: string; compact?: boolean }) {
  const size = compact ? 'h-9 w-9' : 'h-10 w-10';
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center rounded-full border', size)}
      style={{
        borderColor: `color-mix(in srgb, ${accentVar} 32%, transparent)`,
        background: `color-mix(in srgb, ${accentVar} 10%, transparent)`,
        boxShadow: `0 0 18px color-mix(in srgb, ${accentVar} 18%, transparent)`,
      }}
      aria-hidden
    >
      {icon === 'check' && (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke={accentVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.5 3.5L13 5" />
        </svg>
      )}
      {icon === 'warn' && (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke={accentVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 4v5" />
          <path d="M8 11.5h.01" />
          <circle cx="8" cy="8" r="6" />
        </svg>
      )}
      {icon === 'pause' && (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke={accentVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4v8" />
          <path d="M10 4v8" />
        </svg>
      )}
    </div>
  );
}

function deriveTitle(event: BuilderCompletionEventV1): string {
  if (event.status === 'success') {
    return event.artifact_title || event.artifact_filename || 'Your file is ready.';
  }
  if (event.status === 'timeout') {
    return 'Build timed out';
  }
  if (event.status === 'cancelled') {
    return 'Build cancelled';
  }
  return 'Build didn’t complete';
}

function deriveBody(event: BuilderCompletionEventV1): string | null {
  if (event.status === 'success') {
    return event.summary || event.user_next_action || null;
  }
  if (event.status === 'error') {
    return event.error_message || FAILURE_BODY;
  }
  if (event.status === 'timeout') {
    return TIMEOUT_BODY;
  }
  return CANCELLED_BODY;
}

export function BuilderCompletionCard({
  event,
  onOpen,
  onRetry,
  onDismiss,
  compact = false,
  className,
}: BuilderCompletionCardProps) {
  const meta = STATUS_META[event.status];
  const title = useMemo(() => deriveTitle(event), [event]);
  const body = useMemo(() => deriveBody(event), [event]);

  const showOpen = event.status === 'success' && Boolean(event.artifact_url);
  const showRetry = event.status === 'error' || event.status === 'timeout';
  const showDismiss = Boolean(onDismiss);

  const handleOpen: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    if (event.artifact_url) {
      window.open(event.artifact_url, '_blank', 'noopener,noreferrer');
    }
    onOpen?.(event);
  };

  const handleRetry: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    onRetry?.(event);
  };

  const handleDismiss: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    onDismiss?.(event);
  };

  return (
    <div
      role="status"
      aria-live="assertive"
      data-testid="builder-completion-card"
      data-status={event.status}
      className={cn(
        compact
          ? 'w-[min(340px,calc(100vw-40px))] rounded-[20px] border px-3 py-2.5 backdrop-blur-xl transition-all duration-500 animate-[builder-reveal_0.45s_ease-out]'
          : 'w-[min(360px,calc(100vw-48px))] rounded-[22px] border px-3.5 py-3 backdrop-blur-xl transition-all duration-700 animate-[builder-reveal_0.6s_ease-out]',
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 24%, var(--cosmic-border-soft))`,
        background: 'color-mix(in srgb, var(--cosmic-panel) 86%, transparent)',
        boxShadow: `0 16px 36px color-mix(in srgb, ${meta.accentVar} 10%, transparent)`,
      }}
    >
      <div className={cn('flex items-start', compact ? 'gap-2.5' : 'gap-3')}>
        <StatusGlyph icon={meta.icon} accentVar={meta.accentVar} compact={compact} />

        <div className="min-w-0 flex-1">
          <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
            <span
              className={cn(compact ? 'text-[9px]' : 'text-[10px]', 'tracking-[0.14em] lowercase')}
              style={{ color: 'var(--cosmic-text-whisper)' }}
            >
              {meta.label}
            </span>
            <span
              className={cn('rounded-full tracking-[0.1em] lowercase', compact ? 'px-1.5 py-0.5 text-[8px]' : 'px-2 py-0.5 text-[9px]')}
              style={{
                color: meta.accentVar,
                background: `color-mix(in srgb, ${meta.accentVar} 12%, transparent)`,
              }}
            >
              builder
            </span>
          </div>

          <p
            className={cn(
              compact ? 'mt-0.5 text-[12px] leading-5' : 'mt-1 text-[13px] leading-5.5',
              'truncate font-medium',
            )}
            style={{ color: 'var(--cosmic-text-strong)' }}
            title={title}
          >
            {title}
          </p>

          {body && (
            <p
              className={cn(compact ? 'mt-1 text-[10px] leading-4.5' : 'mt-1 text-[11px] leading-5')}
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              {body}
            </p>
          )}

          {event.task_brief && event.status !== 'success' && (
            <p
              className={cn(compact ? 'mt-1 text-[9px] leading-4' : 'mt-1.5 text-[10px] leading-4.5', 'italic line-clamp-2')}
              style={{ color: 'var(--cosmic-text-whisper)' }}
              title={event.task_brief}
            >
              about: {event.task_brief}
            </p>
          )}
        </div>
      </div>

      <div className={cn('flex items-center justify-end gap-2', compact ? 'mt-2' : 'mt-2.5')}>
        {showOpen && event.artifact_url && (
          <button
            type="button"
            onClick={handleOpen}
            className={cn(
              'rounded-full border tracking-[0.08em] lowercase transition-all duration-300',
              compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1 text-[10px]',
            )}
            style={{
              borderColor: `color-mix(in srgb, ${meta.accentVar} 38%, transparent)`,
              background: `color-mix(in srgb, ${meta.accentVar} 14%, transparent)`,
              color: meta.accentVar,
            }}
          >
            open
          </button>
        )}

        {showRetry && (
          <button
            type="button"
            onClick={handleRetry}
            className={cn(
              'rounded-full border tracking-[0.08em] lowercase transition-all duration-300',
              compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1 text-[10px]',
            )}
            style={{
              borderColor: `color-mix(in srgb, ${meta.accentVar} 38%, transparent)`,
              background: `color-mix(in srgb, ${meta.accentVar} 14%, transparent)`,
              color: meta.accentVar,
            }}
          >
            try again
          </button>
        )}

        {showDismiss && (
          <button
            type="button"
            onClick={handleDismiss}
            className="transition-all duration-300"
            style={{ color: 'var(--cosmic-text-faint)' }}
            aria-label="Dismiss"
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
