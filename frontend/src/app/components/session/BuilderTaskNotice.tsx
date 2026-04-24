'use client';

import { useEffect, useMemo, useRef, useState, type MouseEventHandler } from 'react';

import { cn } from '../../lib/utils';
import type { BuilderTaskV1 } from '../../types/builder-task';

import { BuilderActivityLog } from './BuilderActivityLog';

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
// Matches backend subagents.executor._STUCK_IDLE_MS. Generous enough to cover
// long single-LLM iterations on the builder (Sonnet often spends 90–130s on a
// single generation).
const LOCAL_STUCK_IDLE_MS = 150_000;

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

function hasSupplementalBuilderNotes(task: BuilderTaskV1): boolean {
  return Boolean((task.todos && task.todos.length > 0) || (task.activityLog && task.activityLog.length > 0));
}

function getBuilderNotesLabel(task: BuilderTaskV1): string {
  const todoCount = task.todos?.length ?? 0;
  const activityCount = task.activityLog?.length ?? 0;

  if (activityCount > 0 && todoCount > 0) {
    return `${activityCount} live updates · ${todoCount} tasks`;
  }

  if (activityCount > 0) {
    return `${activityCount} live updates`;
  }

  if (todoCount > 0) {
    return `${todoCount} tasks`;
  }

  return 'field notes';
}

/* ── Slim presence dot ── 5px breathing core, no orbiting particles. */
function BuilderBreathingDot({
  accentVar,
  active,
}: {
  accentVar: string;
  active: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className="relative shrink-0"
      style={{ width: 8, height: 8 }}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background: accentVar,
          opacity: active ? 0.9 : 0.7,
          animation: active ? 'builder-core-breath 2.4s ease-in-out infinite' : undefined,
        }}
      />
      {active && (
        <span
          className="absolute inset-[-3px] rounded-full"
          style={{
            border: `1px solid color-mix(in srgb, ${accentVar} 40%, transparent)`,
            opacity: 0.45,
            animation: 'builder-core-breath 2.4s ease-in-out infinite',
          }}
        />
      )}
    </span>
  );
}

/* ── Slim hairline progress ── 2px line under the header row. */
function BuilderHairlineProgress({
  task,
  accentVar,
  elapsedMs,
}: {
  task: BuilderTaskV1;
  accentVar: string;
  elapsedMs?: number;
}) {
  const ratio = getProgressRatio(task, elapsedMs);
  const isDeterminate = ratio !== null;
  const widthPercent = isDeterminate ? Math.round(ratio * 100) : 38;

  return (
    <div
      role="progressbar"
      aria-label={PROGRESSBAR_LABEL}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(isDeterminate
        ? { 'aria-valuenow': Math.round(ratio * 100) }
        : { 'aria-valuetext': 'Builder progress is in motion' })}
      className="relative mt-2 h-[2px] overflow-hidden rounded-full"
      style={{ background: 'color-mix(in srgb, var(--cosmic-text-faint) 12%, transparent)' }}
    >
      {isDeterminate ? (
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width,background] duration-500 ease-out',
            task.phase === 'completed' && 'animate-[builder-complete-surge_700ms_ease-out_1]',
          )}
          style={{
            width: `${widthPercent}%`,
            background: accentVar,
            boxShadow: `0 0 10px color-mix(in srgb, ${accentVar} 30%, transparent)`,
          }}
        />
      ) : (
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: '38%',
            background: accentVar,
            boxShadow: `0 0 10px color-mix(in srgb, ${accentVar} 30%, transparent)`,
            animation: 'builder-progress-indeterminate 1.8s ease-in-out infinite',
          }}
        />
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
  const [isExpanded, setIsExpanded] = useState(task.phase !== 'running');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [taskReceivedAtMs, setTaskReceivedAtMs] = useState(() => Date.now());
  const taskFirstSeenMsRef = useRef(Date.now());
  const expansionIdentityRef = useRef(task.taskId ?? task.label ?? '__builder__');
  const previousTaskStateRef = useRef<{ phase: BuilderTaskV1['phase']; identity: string }>({
    phase: task.phase,
    identity: task.taskId ?? task.label ?? '__builder__',
  });
  const liveTask = useMemo(() => applyLiveTiming(task, nowMs, taskReceivedAtMs), [task, nowMs, taskReceivedAtMs]);
  const taskStartMs = parseTimestampMs(task.startedAt) ?? taskFirstSeenMsRef.current;
  const elapsedMs = Math.max(nowMs - taskStartMs, 0);
  const meta = getDisplayMeta(liveTask);
  const detail = getDetail(liveTask, elapsedMs);
  const progressMeta = getProgressMeta(liveTask, elapsedMs);
  const secondaryLine = getSecondaryMeta(liveTask) ?? detail;
  const showDismiss = Boolean(onDismiss && task.phase !== 'running');
  const showCancel = Boolean(onCancel && task.phase === 'running');
  const isRunning = liveTask.phase === 'running';
  const taskIdentity = task.taskId ?? task.label ?? '__builder__';
  const showReadyPill = task.phase === 'completed' && Boolean(artifactTitle && onOpenArtifact);
  const hasSupplementalNotes = hasSupplementalBuilderNotes(liveTask);
  const notesLabel = getBuilderNotesLabel(liveTask);
  const notesPanelId = `${taskIdentity.replace(/[^a-zA-Z0-9_-]/g, '-')}-builder-notes`;

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

    if (isNewTask) {
      taskFirstSeenMsRef.current = Date.now();
    }

    previousTaskStateRef.current = {
      phase: task.phase,
      identity: taskIdentity,
    };
  }, [task.phase, taskIdentity]);

  useEffect(() => {
    const autoExpand = task.phase !== 'running' || Boolean(liveTask.stuck);
    const isNewTask = expansionIdentityRef.current !== taskIdentity;

    if (isNewTask) {
      expansionIdentityRef.current = taskIdentity;
      setIsExpanded(autoExpand);
      return;
    }

    if (autoExpand) {
      setIsExpanded(true);
    }
  }, [liveTask.stuck, task.phase, taskIdentity]);

  return (
    <div
      role="status"
      aria-live={isRunning ? 'polite' : 'assertive'}
      className={cn(
        'relative w-[min(300px,calc(100vw-40px))] overflow-hidden rounded-2xl border backdrop-blur-md transition-opacity duration-300 animate-[builder-reveal_0.35s_ease-out]',
        compact ? 'px-3 py-2' : 'px-3.5 py-2.5',
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 14%, var(--cosmic-border-soft))`,
        background: 'color-mix(in srgb, var(--cosmic-panel) 70%, transparent)',
      }}
    >
      {/* Header row: dot · phase · leading meta (or artifact title for completed) · percent · notes toggle */}
      <div className="flex items-center gap-2">
        <BuilderBreathingDot accentVar={meta.accentVar} active={isRunning} />
        <span
          className="text-[10px] tracking-[0.16em] lowercase shrink-0"
          style={{ color: 'var(--cosmic-text-whisper)' }}
        >
          {meta.label}
        </span>
        <span aria-hidden="true" style={{ color: 'var(--cosmic-text-faint)' }}>·</span>
        <span
          className="min-w-0 flex-1 truncate text-[10px]"
          style={{ color: 'var(--cosmic-text-faint)' }}
          title={showReadyPill && artifactTitle ? artifactTitle : progressMeta.leading}
        >
          {showReadyPill && artifactTitle ? artifactTitle : progressMeta.leading}
        </span>
        <span
          className="text-[10px] tabular-nums shrink-0"
          style={{ color: 'var(--cosmic-text-whisper)' }}
        >
          {progressMeta.trailing}
        </span>
        {hasSupplementalNotes && (
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
            aria-controls={notesPanelId}
            aria-label={isExpanded ? 'hide notes' : 'field notes'}
            title={isExpanded ? 'hide notes' : `field notes (${notesLabel})`}
            className="shrink-0 -mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors duration-200 hover:bg-white/[0.04]"
            style={{ color: 'var(--cosmic-text-whisper)' }}
          >
            <svg
              className={cn('h-3 w-3 transition-transform duration-300', isExpanded && 'rotate-180')}
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Hairline progress */}
      <BuilderHairlineProgress
        task={liveTask}
        accentVar={meta.accentVar}
        elapsedMs={elapsedMs}
      />

      {/* Optional secondary detail line (active step, stuck reason) */}
      {secondaryLine && (
        <p
          className="mt-1.5 text-[10px] leading-4 truncate"
          style={{ color: 'var(--cosmic-text-whisper)' }}
          title={secondaryLine}
        >
          {secondaryLine}
        </p>
      )}

      {hasSupplementalNotes && (
        <div
          id={notesPanelId}
          className={cn(
            'overflow-hidden transition-[max-height,opacity,margin] duration-400 ease-out',
            isExpanded
              ? 'visible mt-2 max-h-[360px] opacity-100'
              : 'invisible pointer-events-none max-h-0 opacity-0',
          )}
          aria-hidden={!isExpanded}
        >
          <div
            className="h-px w-full mb-2"
            style={{
              background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${meta.accentVar} 18%, var(--cosmic-border-soft)), transparent)`,
            }}
          />
          <BuilderTodoPreview task={liveTask} compact={compact} />
          {liveTask.activityLog && liveTask.activityLog.length > 0 && (
            <BuilderActivityLog entries={liveTask.activityLog} compact={compact} />
          )}
        </div>
      )}

      {(showCancel || showDismiss || (showReadyPill && artifactTitle && onOpenArtifact)) && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {showCancel && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className="rounded-full px-2 py-0.5 text-[9px] lowercase tracking-[0.08em] transition-colors duration-200 disabled:opacity-40 hover:bg-white/[0.04]"
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              {isCancelling ? 'cancelling…' : 'cancel'}
            </button>
          )}

          {showReadyPill && artifactTitle && onOpenArtifact && (
            <button
              type="button"
              onClick={onOpenArtifact}
              className="rounded-full px-2 py-0.5 text-[9px] lowercase tracking-[0.08em] transition-colors duration-200 hover:bg-white/[0.04]"
              style={{ color: 'var(--cosmic-text-faint)' }}
              aria-label="Open"
            >
              Open
            </button>
          )}

          {showReadyPill && downloadHref && (
            <a
              href={downloadHref}
              download
              onClick={onDownload}
              className="rounded-full px-2 py-0.5 text-[9px] lowercase tracking-[0.08em] transition-colors duration-200 hover:bg-white/[0.04]"
              style={{ color: 'var(--cosmic-text-faint)' }}
              aria-label="Download"
            >
              Download
            </a>
          )}

          {showDismiss && onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-full p-1 transition-colors duration-200 hover:bg-white/[0.04]"
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