'use client';

import { ArrowLeft, Home } from 'lucide-react';

import { RetryAction } from '../../components/ui/RetryAction';
import { cn } from '../../lib/utils';

type HeaderVariant = 'skeleton' | 'with-title' | 'compact';

interface RecapPageFloatingHeaderProps {
  variant: HeaderVariant;
  onBack?: () => void;
  onHome?: () => void;
}

export function RecapPageFloatingHeader({ variant, onBack, onHome }: RecapPageFloatingHeaderProps) {
  if (variant === 'skeleton') {
    return (
      <header className="absolute top-0 left-0 right-0 z-50 px-4 py-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="cosmic-surface-panel h-10 w-10 animate-pulse rounded-xl" />
          <div className="cosmic-surface-panel h-10 w-10 animate-pulse rounded-xl" />
        </div>
      </header>
    );
  }

  return (
    <header className="absolute top-0 left-0 right-0 z-50 px-4 py-4">
      <div className="flex items-center justify-between max-w-4xl mx-auto">
        <button
          onClick={onBack}
          className="cosmic-chrome-button rounded-xl p-2.5 transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--cosmic-text-muted)' }} />
        </button>

        {variant === 'with-title' && (
          <span className="font-cormorant text-[14px] tracking-[0.06em]" style={{ color: 'var(--cosmic-text-whisper)' }}>session recap</span>
        )}

        <button
          onClick={onHome}
          className="cosmic-chrome-button rounded-xl p-2.5 transition-colors"
          aria-label="Go home"
        >
          <Home className="w-5 h-5" style={{ color: 'var(--cosmic-text-muted)' }} />
        </button>
      </div>
    </header>
  );
}

interface RecapBottomActionBarProps {
  actionError: string | null;
  actionRetry: (() => void) | null;
  onDismissError: () => void;
  onReturnHome: () => void;
  allReviewed: boolean;
  isSaving: boolean;
  onComplete: () => void;
}

export function RecapBottomActionBar({
  actionError,
  actionRetry,
  onDismissError,
  onReturnHome,
  allReviewed,
  isSaving,
  onComplete,
}: RecapBottomActionBarProps) {
  return (
    <div className="cosmic-bottom-bar fixed bottom-0 left-0 right-0 z-50">
      <div className="px-4 py-4 max-w-2xl mx-auto safe-b">
        {actionError && (
          <div className="mb-3">
            <RetryAction
              message={actionError}
              onRetry={() => {
                if (actionRetry) {
                  actionRetry();
                }
              }}
              onDismiss={onDismissError}
            />
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={onReturnHome}
            className={cn(
              'cosmic-whisper-button cosmic-focus-ring rounded-full px-4 py-2 text-[11px] tracking-[0.08em] uppercase transition-colors'
            )}
          >
            Return home
          </button>

          {allReviewed ? (
            <button
              onClick={onComplete}
              disabled={isSaving}
              data-onboarding="recap-memory-save"
              className={cn(
                'cosmic-accent-pill cosmic-focus-ring rounded-full px-5 py-2 text-[11px] tracking-[0.08em] uppercase transition-all',
                'disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              {isSaving ? 'saving...' : 'complete'}
            </button>
          ) : (
            <span className="font-cormorant italic text-[13px]" style={{ color: 'var(--cosmic-text-whisper)' }}>choose your memories above</span>
          )}
        </div>
      </div>
    </div>
  );
}

interface RecapSaveSuccessOverlayProps {
  count: number;
}

export function RecapSaveSuccessOverlay({ count }: RecapSaveSuccessOverlayProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn">
      <div className="cosmic-modal-backdrop absolute inset-0" />
      <div className="relative text-center">
        <div className="cosmic-surface-panel mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full animate-pop-in">
          <svg className="w-8 h-8" style={{ color: 'var(--cosmic-text)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="mb-2 font-cormorant text-[22px]" style={{ color: 'var(--cosmic-text-strong)' }}>
          {count === 1 ? 'memory saved' : `${count} memories saved`}
        </h2>
        <p className="text-[12px] tracking-[0.06em]" style={{ color: 'var(--cosmic-text-whisper)' }}>sophia will remember this next time</p>
      </div>
    </div>
  );
}
