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
          <div className="w-10 h-10 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] animate-pulse" />
          <div className="w-10 h-10 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] animate-pulse" />
        </div>
      </header>
    );
  }

  return (
    <header className="absolute top-0 left-0 right-0 z-50 px-4 py-4">
      <div className="flex items-center justify-between max-w-4xl mx-auto">
        <button
          onClick={onBack}
          className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] hover:bg-white/[0.08] transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-white/40" />
        </button>

        {variant === 'with-title' && (
          <span className="font-cormorant text-[14px] tracking-[0.06em] text-white/30">session recap</span>
        )}

        <button
          onClick={onHome}
          className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] hover:bg-white/[0.08] transition-colors"
          aria-label="Go home"
        >
          <Home className="w-5 h-5 text-white/40" />
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
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-[rgba(3,3,8,0.65)] backdrop-blur-[20px] border-t border-white/[0.04]">
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
              'px-4 py-2 rounded-full transition-colors',
              'text-[11px] tracking-[0.08em] uppercase text-white/30 hover:text-white/50 hover:bg-white/[0.04]'
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
                'px-5 py-2 rounded-full transition-all',
                'text-[11px] tracking-[0.08em] uppercase',
                'bg-white/[0.08] border border-white/[0.10] text-white/60',
                'hover:bg-white/[0.12] hover:text-white/80',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20',
                'disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              {isSaving ? 'saving...' : 'complete'}
            </button>
          ) : (
            <span className="font-cormorant italic text-[13px] text-white/25">choose your memories above</span>
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
      <div className="absolute inset-0 bg-[rgba(3,3,8,0.75)] backdrop-blur-sm" />
      <div className="relative text-center">
        <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-white/[0.04] border border-white/[0.06] flex items-center justify-center animate-pop-in">
          <svg className="w-8 h-8 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="font-cormorant text-[22px] text-white/70 mb-2">
          {count === 1 ? 'memory saved' : `${count} memories saved`}
        </h2>
        <p className="text-[12px] tracking-[0.06em] text-white/30">sophia will remember this next time</p>
      </div>
    </div>
  );
}
