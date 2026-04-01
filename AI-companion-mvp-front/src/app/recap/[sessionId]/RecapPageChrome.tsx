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
          <div className="w-10 h-10 rounded-xl bg-sophia-surface/20 backdrop-blur-sm border border-sophia-surface-border animate-pulse" />
          <div className="w-10 h-10 rounded-xl bg-sophia-surface/20 backdrop-blur-sm border border-sophia-surface-border animate-pulse" />
        </div>
      </header>
    );
  }

  return (
    <header className="absolute top-0 left-0 right-0 z-50 px-4 py-4">
      <div className="flex items-center justify-between max-w-4xl mx-auto">
        <button
          onClick={onBack}
          className="p-2.5 rounded-xl bg-sophia-surface/20 backdrop-blur-sm border border-sophia-surface-border hover:bg-sophia-surface/40 hover:border-sophia-purple/50 transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-sophia-text2" />
        </button>

        {variant === 'with-title' && (
          <span className="text-sm font-medium text-sophia-text2/50">Session Recap</span>
        )}

        <button
          onClick={onHome}
          className="p-2.5 rounded-xl bg-sophia-surface/20 backdrop-blur-sm border border-sophia-surface-border hover:bg-sophia-surface/40 hover:border-sophia-purple/50 transition-colors"
          aria-label="Go home"
        >
          <Home className="w-5 h-5 text-sophia-text2" />
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
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-sophia-bg/80 backdrop-blur-lg border-t border-sophia-surface-border">
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
              'px-4 py-2.5 text-sm font-medium rounded-xl transition-colors',
              'text-sophia-text2/70 hover:text-sophia-text hover:bg-sophia-surface/30'
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
                'px-6 py-2.5 text-sm font-medium rounded-xl transition-all',
                'bg-sophia-purple/90 text-sophia-bg hover:bg-sophia-purple',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2 focus-visible:ring-offset-sophia-bg',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {isSaving ? 'Saving...' : 'Complete'}
            </button>
          ) : (
            <span className="text-sm text-sophia-text2/50 italic">Choose your memories above</span>
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
      <div className="absolute inset-0 bg-sophia-bg/90 backdrop-blur-sm" />
      <div className="relative text-center">
        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-sophia-accent/20 flex items-center justify-center animate-pop-in">
          <svg className="w-10 h-10 text-sophia-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-sophia-text mb-2">
          {count === 1 ? 'Memory Saved!' : `${count} Memories Saved!`}
        </h2>
        <p className="text-sm text-sophia-text2">Sophia will remember this next time</p>
      </div>
    </div>
  );
}
