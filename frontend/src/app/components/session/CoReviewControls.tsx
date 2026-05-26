'use client';

import { Eye, EyeOff } from 'lucide-react';

import type { CoReviewState } from '../../lib/co-review-capture';
import { cn } from '../../lib/utils';

type CoReviewControlsProps = {
  enabled: boolean;
  state: CoReviewState;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
};

export function CoReviewControls({
  enabled,
  state,
  error,
  onStart,
  onStop,
}: CoReviewControlsProps) {
  if (!enabled) return null;

  const isLive = state === 'live';
  const isBusy = state === 'starting' || state === 'stopping';

  return (
    <div
      className="mt-3 flex flex-col items-center gap-2"
      onClick={(event) => event.stopPropagation()}
    >
      {isLive ? (
        <div
          className={cn(
            'flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border px-3 py-1.5 text-[10px]',
            'motion-safe:transition-colors motion-safe:duration-500',
          )}
          style={{
            borderColor: 'color-mix(in srgb, var(--cosmic-teal) 36%, var(--cosmic-border-soft))',
            color: 'var(--cosmic-text-strong)',
            background: 'color-mix(in srgb, var(--cosmic-teal) 10%, var(--cosmic-panel-soft))',
          }}
          role="status"
          aria-live="polite"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Sophia is looking at this artifact</span>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[10px] transition-colors hover:text-[var(--cosmic-text)]"
            style={{
              borderColor: 'var(--cosmic-border-soft)',
              color: 'var(--cosmic-text-whisper)',
            }}
            onClick={onStop}
          >
            <EyeOff className="h-3 w-3" aria-hidden="true" />
            Stop looking
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[10px] tracking-[0.08em] transition-colors hover:text-[var(--cosmic-text)] disabled:cursor-wait disabled:opacity-60"
          style={{
            borderColor: 'color-mix(in srgb, var(--sophia-purple) 30%, var(--cosmic-border-soft))',
            color: 'var(--sophia-purple)',
            background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
          }}
          onClick={onStart}
          disabled={isBusy}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          {state === 'starting' ? 'Starting review' : 'Review together'}
        </button>
      )}

      {state === 'error' && error && (
        <p
          className="max-w-[280px] text-center text-[9px] leading-relaxed"
          style={{ color: 'var(--cosmic-text-faint)' }}
          role="status"
        >
          Co-review unavailable: {error.replace(/_/g, ' ')}
        </p>
      )}
    </div>
  );
}
