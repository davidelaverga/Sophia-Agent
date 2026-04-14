'use client';

import { cn } from '../../lib/utils';
import type { BuilderTaskV1 } from '../../types/builder-task';

type BuilderTaskNoticeProps = {
  task: BuilderTaskV1;
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

function getDetail(task: BuilderTaskV1): string | null {
  if (task.detail) return task.detail;
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

export function BuilderTaskNotice({
  task,
  onDismiss,
  onCancel,
  isCancelling = false,
  className,
}: BuilderTaskNoticeProps) {
  const meta = PHASE_META[task.phase];
  const detail = getDetail(task);
  const showDismiss = Boolean(onDismiss && task.phase !== 'running');
  const showCancel = Boolean(onCancel && task.phase === 'running');
  const isRunning = task.phase === 'running';

  return (
    <div
      role="status"
      aria-live={isRunning ? 'polite' : 'assertive'}
      className={cn(
        'flex flex-col items-center gap-2 py-3 transition-all duration-700',
        className,
      )}
    >
      {/* Constellation animation — running only */}
      {isRunning ? (
        <BuilderConstellation />
      ) : (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{
            background: meta.accentVar,
            boxShadow: `0 0 8px color-mix(in srgb, ${meta.accentVar} 40%, transparent)`,
          }}
        />
      )}

      {/* Status + detail */}
      <div className="flex items-center gap-2">
        <span
          className="text-[10px] tracking-[0.14em] lowercase"
          style={{ color: 'var(--cosmic-text-whisper)' }}
        >
          {meta.label}
        </span>

        {detail && (
          <>
            <span className="text-[10px]" style={{ color: 'var(--cosmic-text-faint)' }}>·</span>
            <span
              className="max-w-[200px] truncate text-[10px] tracking-[0.06em] lowercase"
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              {detail}
            </span>
          </>
        )}

        {showCancel && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isCancelling}
            className="ml-1 text-[10px] tracking-[0.08em] lowercase transition-all duration-300 disabled:opacity-40"
            style={{ color: 'var(--cosmic-text-faint)' }}
          >
            {isCancelling ? 'cancelling…' : 'cancel'}
          </button>
        )}

        {showDismiss && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="ml-0.5 transition-all duration-300"
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