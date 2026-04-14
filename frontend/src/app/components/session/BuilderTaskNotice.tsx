'use client';

import { useEffect, useRef, useState, type MouseEventHandler } from 'react';

import { cn } from '../../lib/utils';
import type { BuilderTaskV1 } from '../../types/builder-task';

import { BuilderReadyPill } from './BuilderReadyPill';

type BuilderTaskNoticeProps = {
  task: BuilderTaskV1;
  artifactTitle?: string;
  onOpenArtifact?: () => void;
  downloadHref?: string | null;
  onDownload?: MouseEventHandler<HTMLAnchorElement>;
  compact?: boolean;
  onDismiss?: () => void;
  onCancel?: () => void;
  isCancelling?: boolean;
  className?: string;
};

const PHASE_META: Record<BuilderTaskV1['phase'], {
  label: string;
  accentVar: string;
}> = {
  running:   { label: 'building',    accentVar: 'var(--sophia-purple)' },
  completed: { label: 'ready',       accentVar: 'var(--cosmic-teal)' },
  failed:    { label: 'failed',      accentVar: 'var(--sophia-error, #f87171)' },
  timed_out: { label: 'timed out',   accentVar: 'var(--cosmic-amber)' },
  cancelled: { label: 'cancelled',   accentVar: 'var(--cosmic-text-faint)' },
};

const PROGRESSBAR_LABEL = 'Builder progress';

function getDetail(task: BuilderTaskV1): string | null {
  if (task.detail && !/^working through step\s+/i.test(task.detail.trim())) return task.detail;
  if (task.label) return task.label;
  if (
    task.phase === 'running' &&
    typeof task.messageIndex === 'number' &&
    typeof task.totalMessages === 'number' &&
    task.totalMessages > 0
  ) {
    return `step ${task.messageIndex} of ${task.totalMessages}`;
  }
  return null;
}

function getProgressRatio(task: BuilderTaskV1): number | null {
  if (task.phase !== 'running') {
    return 1;
  }

  if (
    typeof task.messageIndex === 'number' &&
    typeof task.totalMessages === 'number' &&
    task.totalMessages > 0
  ) {
    const rawRatio = task.messageIndex / task.totalMessages;
    return Math.min(0.96, Math.max(0.12, rawRatio));
  }

  return null;
}

function getProgressMeta(task: BuilderTaskV1): { leading: string; trailing: string } {
  const ratio = getProgressRatio(task);
  const percentLabel = ratio === null ? 'in motion' : `${Math.round(ratio * 100)}%`;

  if (
    task.phase === 'running' &&
    typeof task.messageIndex === 'number' &&
    typeof task.totalMessages === 'number' &&
    task.totalMessages > 0
  ) {
    return {
      leading: `${task.messageIndex} of ${task.totalMessages} steps`,
      trailing: percentLabel,
    };
  }

  switch (task.phase) {
    case 'running':
      return { leading: 'assembling deliverable', trailing: percentLabel };
    case 'completed':
      return { leading: 'deliverable assembled', trailing: '100%' };
    case 'failed':
      return { leading: 'build interrupted', trailing: '100%' };
    case 'timed_out':
      return { leading: 'builder timed out', trailing: '100%' };
    case 'cancelled':
      return { leading: 'build stopped', trailing: '100%' };
  }
}

/* ── Constellation spinner ── 3 tiny particles orbiting a breathing core */
function BuilderConstellation() {
  const particles = [
    { delay: '0s',    duration: '3s',   radius: '14px', size: 3,   opacity: 0.6 },
    { delay: '0.9s',  duration: '4.2s', radius: '10px', size: 2,   opacity: 0.4 },
    { delay: '1.8s',  duration: '5.4s', radius: '18px', size: 2.5, opacity: 0.5 },
  ];

  return (
    <div className="relative flex items-center justify-center" style={{ width: 40, height: 40 }}>
      {/* Core — breathing glow */}
      <div
        className="absolute rounded-full"
        style={{
          width: 6,
          height: 6,
          background: 'var(--sophia-purple)',
          animation: 'builder-core-breath 2.4s ease-in-out infinite',
        }}
      />
      {/* Orbiting particles */}
      {particles.map((p, i) => (
        <div
          key={i}
          className="absolute inset-0 flex items-center justify-center"
          style={{
            ['--orbit-r' as string]: p.radius,
            animation: `builder-orbit ${p.duration} linear ${p.delay} infinite`,
          }}
        >
          <div
            className="rounded-full"
            style={{
              width: p.size,
              height: p.size,
              background: 'var(--sophia-purple)',
              opacity: p.opacity,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function BuilderStatusGlyph({
  isRunning,
  accentVar,
  compact,
}: {
  isRunning: boolean;
  accentVar: string;
  compact?: boolean;
}) {
  if (isRunning) {
    return <BuilderConstellation />;
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-full border',
        compact ? 'h-9 w-9' : 'h-10 w-10',
      )}
      style={{
        borderColor: `color-mix(in srgb, ${accentVar} 28%, transparent)`,
        background: `color-mix(in srgb, ${accentVar} 8%, transparent)`,
        boxShadow: `0 0 18px color-mix(in srgb, ${accentVar} 16%, transparent)`,
      }}
    >
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{
          background: accentVar,
          boxShadow: `0 0 12px color-mix(in srgb, ${accentVar} 40%, transparent)`,
        }}
      />
    </div>
  );
}

function BuilderProgressTrack({
  task,
  accentVar,
  compact,
}: {
  task: BuilderTaskV1;
  accentVar: string;
  compact?: boolean;
}) {
  const ratio = getProgressRatio(task);
  const isDeterminate = ratio !== null;
  const progressWidth = isDeterminate ? Math.max(10, Math.round(ratio * 100)) : 38;
  const progressMeta = getProgressMeta(task);

  return (
    <div className="space-y-1.5">
      <div
        role="progressbar"
        aria-label={PROGRESSBAR_LABEL}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(isDeterminate
          ? { 'aria-valuenow': Math.round(ratio * 100) }
          : { 'aria-valuetext': 'Builder progress is in motion' })}
        className={cn('relative overflow-hidden rounded-full border', compact ? 'h-2' : 'h-2.5')}
        style={{
          borderColor: `color-mix(in srgb, ${accentVar} 22%, var(--cosmic-border-soft))`,
          background: 'color-mix(in srgb, var(--cosmic-panel-soft) 72%, transparent)',
        }}
      >
        <div
          className="absolute inset-0 opacity-40"
          style={{
            background: 'repeating-linear-gradient(90deg, transparent 0 10px, color-mix(in srgb, var(--cosmic-text-faint) 10%, transparent) 10px 18px)',
          }}
        />

        {isDeterminate ? (
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-[width,background,box-shadow,filter] duration-700 ease-out',
              task.phase === 'completed' && 'animate-[builder-complete-surge_900ms_ease-out_1]',
            )}
            style={{
              width: `${progressWidth}%`,
              background: `linear-gradient(90deg, color-mix(in srgb, ${accentVar} 58%, white 6%), ${accentVar})`,
              boxShadow: `0 0 16px color-mix(in srgb, ${accentVar} 20%, transparent)`,
            }}
          >
            <div
              className="absolute inset-y-0 left-[-40%] w-[40%]"
              style={{
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)',
                animation: 'builder-progress-sheen 1.8s linear infinite',
              }}
            />
          </div>
        ) : (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: '38%',
              background: `linear-gradient(90deg, color-mix(in srgb, ${accentVar} 50%, white 8%), ${accentVar})`,
              boxShadow: `0 0 14px color-mix(in srgb, ${accentVar} 18%, transparent)`,
              animation: 'builder-progress-indeterminate 1.8s ease-in-out infinite',
            }}
          />
        )}

        {task.phase === 'completed' && (
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.22), transparent)',
              animation: 'builder-progress-spark 900ms ease-out 1',
            }}
          />
        )}
      </div>

      <div className={cn('flex items-center justify-between gap-3 tracking-[0.08em] lowercase', compact ? 'text-[9px]' : 'text-[10px]')} style={{ color: 'var(--cosmic-text-faint)' }}>
        <span>{progressMeta.leading}</span>
        <span>{progressMeta.trailing}</span>
      </div>
    </div>
  );
}

export function BuilderTaskNotice({
  task,
  artifactTitle,
  onOpenArtifact,
  downloadHref,
  onDownload,
  compact = false,
  onDismiss,
  onCancel,
  isCancelling = false,
  className,
}: BuilderTaskNoticeProps) {
  const [isFreshCompletion, setIsFreshCompletion] = useState(false);
  const previousTaskStateRef = useRef<{ phase: BuilderTaskV1['phase']; identity: string }>({
    phase: task.phase,
    identity: task.taskId ?? task.label ?? '__builder__',
  });
  const meta = PHASE_META[task.phase];
  const detail = getDetail(task);
  const showDismiss = Boolean(onDismiss && task.phase !== 'running');
  const showCancel = Boolean(onCancel && task.phase === 'running');
  const isRunning = task.phase === 'running';
  const taskIdentity = task.taskId ?? task.label ?? '__builder__';
  const showReadyPill = task.phase === 'completed' && Boolean(artifactTitle && onOpenArtifact);

  useEffect(() => {
    const previousTaskState = previousTaskStateRef.current;
    const justCompleted = task.phase === 'completed' && (
      previousTaskState.phase !== 'completed' || previousTaskState.identity !== taskIdentity
    );

    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (justCompleted) {
      setIsFreshCompletion(true);
      timerId = setTimeout(() => setIsFreshCompletion(false), compact ? 1400 : 1800);
    } else if (task.phase !== 'completed') {
      setIsFreshCompletion(false);
    }

    previousTaskStateRef.current = {
      phase: task.phase,
      identity: taskIdentity,
    };

    return () => {
      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, [task.phase, taskIdentity, compact]);

  if (showReadyPill && artifactTitle && onOpenArtifact) {
    return (
      <div
        role="status"
        aria-live="assertive"
        className={cn('relative w-[min(360px,calc(100vw-48px))]', className)}
      >
        <BuilderReadyPill
          title={artifactTitle}
          onOpen={onOpenArtifact}
          downloadHref={downloadHref}
          onDownload={onDownload}
          isNew={isFreshCompletion}
          compact={compact}
          className="w-full"
        />

        {showDismiss && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="absolute right-2.5 top-2.5 rounded-full p-1 transition-all duration-300"
            style={{ color: 'var(--cosmic-text-faint)' }}
            aria-label="Dismiss"
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live={isRunning ? 'polite' : 'assertive'}
      className={cn(
        compact
          ? 'w-[min(312px,calc(100vw-40px))] rounded-[20px] border px-3 py-2.5 backdrop-blur-xl transition-all duration-500 animate-[builder-reveal_0.45s_ease-out]'
          : 'w-[min(264px,calc(100vw-48px))] rounded-[22px] border px-3.5 py-3 backdrop-blur-xl transition-all duration-700 animate-[builder-reveal_0.6s_ease-out]',
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 20%, var(--cosmic-border-soft))`,
        background: 'color-mix(in srgb, var(--cosmic-panel) 84%, transparent)',
        boxShadow: `0 16px 36px color-mix(in srgb, ${meta.accentVar} 8%, transparent)`,
      }}
    >
      <div className={cn('flex items-start', compact ? 'gap-2.5' : 'gap-3')}>
        <div className="shrink-0">
          <BuilderStatusGlyph isRunning={isRunning} accentVar={meta.accentVar} compact={compact} />
        </div>

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

          {detail && (
            <p
              className={cn(compact ? 'mt-0.5 text-[10px] leading-4.5' : 'mt-1 text-[11px] leading-5')}
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              {detail}
            </p>
          )}
        </div>
      </div>

      <div className={cn(compact ? 'mt-2.5' : 'mt-3')}>
        <BuilderProgressTrack task={task} accentVar={meta.accentVar} compact={compact} />
      </div>

      {(showCancel || showDismiss) && (
        <div className={cn('flex items-center justify-end gap-2', compact ? 'mt-1.5' : 'mt-2')}>
          {showCancel && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className={cn(compact ? 'text-[9px]' : 'text-[10px]', 'tracking-[0.08em] lowercase transition-all duration-300 disabled:opacity-40')}
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              {isCancelling ? 'cancelling…' : 'cancel'}
            </button>
          )}

          {showDismiss && onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
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
      )}
    </div>
  );
}