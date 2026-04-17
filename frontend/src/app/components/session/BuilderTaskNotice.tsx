'use client';

import { useEffect, useMemo, useRef, useState, type MouseEventHandler } from 'react';

import { cn } from '../../lib/utils';
import type { BuilderTaskV1 } from '../../types/builder-task';

import { BuilderActivityLog } from './BuilderActivityLog';
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
const LOCAL_STUCK_IDLE_MS = 45_000;

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function diffMs(startMs: number | null, endMs: number): number | null {
  if (startMs === null) {
    return null;
  }

  const delta = endMs - startMs;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function formatElapsed(valueMs: number | undefined): string | null {
  if (typeof valueMs !== 'number' || !Number.isFinite(valueMs) || valueMs < 0) {
    return null;
  }

  if (valueMs < 1000) {
    return '<1s';
  }

  const totalSeconds = Math.round(valueMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function applyLiveTiming(task: BuilderTaskV1, nowMs: number, receivedAtMs: number): BuilderTaskV1 {
  const eventAgeMs = Math.max(nowMs - receivedAtMs, 0);
  const inferredHeartbeatMs = diffMs(parseTimestampMs(task.lastUpdateAt), nowMs);
  const inferredIdleMs = diffMs(parseTimestampMs(task.lastProgressAt ?? task.lastUpdateAt), nowMs);
  const heartbeatMs = typeof task.heartbeatMs === 'number' || typeof inferredHeartbeatMs === 'number'
    ? Math.max((task.heartbeatMs ?? 0) + eventAgeMs, inferredHeartbeatMs ?? 0)
    : undefined;
  const idleMs = typeof task.idleMs === 'number' || typeof inferredIdleMs === 'number'
    ? Math.max((task.idleMs ?? 0) + eventAgeMs, inferredIdleMs ?? 0)
    : undefined;
  const stuck = task.phase === 'running' && (Boolean(task.stuck) || (typeof idleMs === 'number' && idleMs >= LOCAL_STUCK_IDLE_MS));
  const stuckReason = task.stuckReason
    ?? (stuck && typeof idleMs === 'number'
      ? `No visible builder progress for ${formatElapsed(idleMs) ?? 'a while'}. It may be blocked on a tool or looping without advancing the deliverable.`
      : undefined);

  return {
    ...task,
    heartbeatMs,
    idleMs,
    stuck,
    stuckReason,
  };
}

function getDisplayMeta(task: BuilderTaskV1): { label: string; accentVar: string } {
  if (task.phase === 'running' && task.stuck) {
    return { label: 'stalled', accentVar: 'var(--cosmic-amber)' };
  }

  return PHASE_META[task.phase];
}

/* ── Early-stage phased messaging ──
 * Before the builder has written todos or produced activity entries,
 * cycle through descriptive labels so the user sees progress even
 * during the initial planning/tool-spin-up window (first ~8-12s). */
const EARLY_STAGES = [
  { label: 'analyzing your request',   durationMs: 3000, pseudoPercent: 5  },
  { label: 'planning the deliverable', durationMs: 4000, pseudoPercent: 12 },
  { label: 'preparing workspace',      durationMs: 5000, pseudoPercent: 18 },
  { label: 'assembling content',       durationMs: 0,    pseudoPercent: 22 },
] as const;

function getEarlyStageIndex(elapsedMs: number): number {
  let accumulated = 0;
  for (let i = 0; i < EARLY_STAGES.length - 1; i++) {
    accumulated += EARLY_STAGES[i].durationMs;
    if (elapsedMs < accumulated) return i;
  }
  return EARLY_STAGES.length - 1;
}

function hasRealProgressData(task: BuilderTaskV1): boolean {
  if (typeof task.totalSteps === 'number' && task.totalSteps > 0) return true;
  if (typeof task.progressPercent === 'number') return true;
  if (task.activityLog && task.activityLog.length > 0) return true;
  if (task.todos && task.todos.length > 0) return true;
  if (typeof task.messageIndex === 'number' && typeof task.totalMessages === 'number' && task.totalMessages > 0) return true;
  if (task.activeStepTitle) return true;
  return false;
}

function getDetail(task: BuilderTaskV1, elapsedMs?: number): string | null {
  if (task.phase === 'running' && task.stuckReason) return task.stuckReason;
  if (task.detail && !/^working through step\s+/i.test(task.detail.trim())) return task.detail;
  if (task.activeStepTitle) return `Active step: ${task.activeStepTitle}`;
  if (task.label) return task.label;
  if (
    typeof task.completedSteps === 'number' &&
    typeof task.totalSteps === 'number' &&
    task.totalSteps > 0
  ) {
    return `Completed ${task.completedSteps} of ${task.totalSteps} builder steps.`;
  }
  if (
    task.phase === 'running' &&
    typeof task.messageIndex === 'number' &&
    typeof task.totalMessages === 'number' &&
    task.totalMessages > 0
  ) {
    return `step ${task.messageIndex} of ${task.totalMessages}`;
  }
  // Early-stage fallback
  if (task.phase === 'running' && typeof elapsedMs === 'number' && !hasRealProgressData(task)) {
    const stage = EARLY_STAGES[getEarlyStageIndex(elapsedMs)];
    return stage ? `${stage.label}…` : null;
  }
  return null;
}

function getProgressRatio(task: BuilderTaskV1, elapsedMs?: number): number | null {
  if (typeof task.progressPercent === 'number') {
    return Math.min(1, Math.max(0, task.progressPercent / 100));
  }

  if (
    typeof task.completedSteps === 'number' &&
    typeof task.totalSteps === 'number' &&
    task.totalSteps > 0
  ) {
    return Math.min(1, Math.max(0, task.completedSteps / task.totalSteps));
  }

  if (task.phase === 'completed') {
    return 1;
  }

  if (
    typeof task.messageIndex === 'number' &&
    typeof task.totalMessages === 'number' &&
    task.totalMessages > 0
  ) {
    return Math.min(1, Math.max(0, task.messageIndex / task.totalMessages));
  }

  // Early-stage pseudo-progress
  if (task.phase === 'running' && typeof elapsedMs === 'number' && !hasRealProgressData(task)) {
    const stage = EARLY_STAGES[getEarlyStageIndex(elapsedMs)];
    if (stage) return stage.pseudoPercent / 100;
  }

  return null;
}

function getProgressMeta(task: BuilderTaskV1, elapsedMs?: number): { leading: string; trailing: string } {
  const ratio = getProgressRatio(task, elapsedMs);
  const percentLabel = typeof task.progressPercent === 'number'
    ? `${task.progressPercent}%`
    : ratio === null
      ? 'in motion'
      : `${Math.round(ratio * 100)}%`;

  if (
    typeof task.completedSteps === 'number' &&
    typeof task.totalSteps === 'number' &&
    task.totalSteps > 0
  ) {
    const activeSegment = typeof task.inProgressSteps === 'number' && task.inProgressSteps > 0
      ? ` | ${task.inProgressSteps} active`
      : '';
    return {
      leading: `${task.completedSteps} of ${task.totalSteps} steps${activeSegment}`,
      trailing: percentLabel,
    };
  }

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
    case 'running': {
      let leading = task.stuck ? 'no visible progress' : 'assembling deliverable';
      if (!task.stuck && typeof elapsedMs === 'number' && !hasRealProgressData(task)) {
        const stage = EARLY_STAGES[getEarlyStageIndex(elapsedMs)];
        if (stage) leading = stage.label;
      }
      return { leading, trailing: percentLabel };
    }
    case 'completed':
      return { leading: 'deliverable assembled', trailing: '100%' };
    case 'failed':
      return { leading: 'build interrupted', trailing: percentLabel };
    case 'timed_out':
      return { leading: 'builder timed out', trailing: percentLabel };
    case 'cancelled':
      return { leading: 'build stopped', trailing: percentLabel };
  }
}

function getSecondaryMeta(task: BuilderTaskV1): string | null {
  if (task.phase === 'running' && task.stuckReason) {
    return task.stuckReason;
  }

  const activeStep = task.activeStepTitle ? `active: ${task.activeStepTitle}` : null;
  const idle = formatElapsed(task.idleMs);

  if (task.phase === 'running' && idle) {
    return activeStep ? `${activeStep} | no progress for ${idle}` : `no progress for ${idle}`;
  }

  return activeStep;
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
  elapsedMs,
}: {
  task: BuilderTaskV1;
  accentVar: string;
  compact?: boolean;
  elapsedMs?: number;
}) {
  const ratio = getProgressRatio(task, elapsedMs);
  const isDeterminate = ratio !== null;
  const progressWidth = isDeterminate ? Math.round(ratio * 100) : 38;
  const progressMeta = getProgressMeta(task, elapsedMs);
  const secondaryMeta = getSecondaryMeta(task);

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

      {secondaryMeta && (
        <p
          className={cn(compact ? 'text-[9px] leading-4' : 'text-[10px] leading-4.5')}
          style={{ color: 'var(--cosmic-text-whisper)' }}
        >
          {secondaryMeta}
        </p>
      )}
    </div>
  );
}

function BuilderTodoPreview({
  task,
  compact,
}: {
  task: BuilderTaskV1;
  compact?: boolean;
}) {
  if (!task.todos || task.todos.length === 0) {
    return null;
  }

  return (
    <div className={cn('space-y-1.5', compact ? 'mt-2' : 'mt-2.5')}>
      {task.todos.slice(0, compact ? 2 : 3).map((todo, index) => {
        const tone = todo.status === 'completed'
          ? 'var(--cosmic-teal)'
          : todo.status === 'in-progress'
            ? 'var(--cosmic-amber)'
            : 'var(--cosmic-text-faint)';

        return (
          <div
            key={`${todo.id ?? index}-${todo.title}`}
            className={cn('flex items-center gap-2 rounded-full border px-2.5 py-1.5', compact ? 'text-[9px]' : 'text-[10px]')}
            style={{
              borderColor: `color-mix(in srgb, ${tone} 18%, transparent)`,
              background: `color-mix(in srgb, ${tone} 6%, transparent)`,
              color: 'var(--cosmic-text-faint)',
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: tone }}
            />
            <span className="min-w-0 truncate">{todo.title}</span>
            <span className="ml-auto lowercase tracking-[0.08em]" style={{ color: tone }}>
              {todo.status === 'in-progress' ? 'active' : todo.status === 'completed' ? 'done' : 'queued'}
            </span>
          </div>
        );
      })}
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [taskReceivedAtMs, setTaskReceivedAtMs] = useState(() => Date.now());
  const taskFirstSeenMsRef = useRef(Date.now());
  const previousTaskStateRef = useRef<{ phase: BuilderTaskV1['phase']; identity: string }>({
    phase: task.phase,
    identity: task.taskId ?? task.label ?? '__builder__',
  });
  const liveTask = useMemo(() => applyLiveTiming(task, nowMs, taskReceivedAtMs), [task, nowMs, taskReceivedAtMs]);
  const taskStartMs = parseTimestampMs(task.startedAt) ?? taskFirstSeenMsRef.current;
  const elapsedMs = Math.max(nowMs - taskStartMs, 0);
  const meta = getDisplayMeta(liveTask);
  const detail = getDetail(liveTask, elapsedMs);
  const showDismiss = Boolean(onDismiss && task.phase !== 'running');
  const showCancel = Boolean(onCancel && task.phase === 'running');
  const isRunning = liveTask.phase === 'running';
  const taskIdentity = task.taskId ?? task.label ?? '__builder__';
  const showReadyPill = task.phase === 'completed' && Boolean(artifactTitle && onOpenArtifact);

  useEffect(() => {
    setTaskReceivedAtMs(Date.now());
  }, [task]);

  useEffect(() => {
    if (task.phase !== 'running') {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [task.phase]);

  useEffect(() => {
    const previousTaskState = previousTaskStateRef.current;
    const isNewTask = previousTaskState.identity !== taskIdentity;
    const justCompleted = task.phase === 'completed' && (
      previousTaskState.phase !== 'completed' || isNewTask
    );

    if (isNewTask) {
      taskFirstSeenMsRef.current = Date.now();
    }

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
          ? 'w-[min(340px,calc(100vw-40px))] rounded-[20px] border px-3 py-2.5 backdrop-blur-xl transition-all duration-500 animate-[builder-reveal_0.45s_ease-out]'
          : 'w-[min(340px,calc(100vw-48px))] rounded-[22px] border px-3.5 py-3 backdrop-blur-xl transition-all duration-700 animate-[builder-reveal_0.6s_ease-out]',
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
        <BuilderProgressTrack task={liveTask} accentVar={meta.accentVar} compact={compact} elapsedMs={elapsedMs} />
        <BuilderTodoPreview task={liveTask} compact={compact} />
        {liveTask.activityLog && liveTask.activityLog.length > 0 && (
          <BuilderActivityLog entries={liveTask.activityLog} compact={compact} />
        )}
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