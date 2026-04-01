'use client';

import { RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';
import { RetryAction } from '../ui/RetryAction';
import { errorCopy } from '../../lib/error-copy';

type RecapEmptyStatus = 'processing' | 'unavailable' | 'not_found';

interface RecapEmptyStateViewsProps {
  status: RecapEmptyStatus;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export function RecapEmptyStateViews({
  status,
  onRetry,
  onDismiss,
  className,
}: RecapEmptyStateViewsProps) {
  if (status === 'processing') {
    return (
      <div className={cn(
        'bg-sophia-surface rounded-2xl p-8 text-center border border-sophia-surface-border',
        className
      )}>
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-sophia-purple/10 flex items-center justify-center">
          <RefreshCw className="w-6 h-6 text-sophia-purple animate-spin" />
        </div>
        <h3 className="text-lg font-medium text-sophia-text mb-2">
          Recap is still processing
        </h3>
        <p className="text-sophia-text2 mb-4">
          Check again in a moment
        </p>
        {onRetry && (
          <div className="mt-4">
            <RetryAction message={errorCopy.recapLoadFailed} onRetry={onRetry} onDismiss={onDismiss} />
          </div>
        )}
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className={cn(
        'bg-sophia-surface rounded-2xl p-8 text-center border border-sophia-surface-border',
        className
      )}>
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
          <Sparkles className="w-6 h-6 text-amber-500" />
        </div>
        <h3 className="text-lg font-medium text-sophia-text mb-2">
          Recap unavailable
        </h3>
        <p className="text-sophia-text2 mb-4">
          This session didn&apos;t generate artifacts. That&apos;s okay — not every session needs a recap.
        </p>
      </div>
    );
  }

  return (
    <div className={cn(
      'bg-sophia-surface rounded-2xl p-8 text-center border border-sophia-surface-border',
      className
    )}>
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-sophia-surface-border flex items-center justify-center">
        <Sparkles className="w-6 h-6 text-sophia-text2" />
      </div>
      <h3 className="text-lg font-medium text-sophia-text mb-2">
        Recap not found
      </h3>
      <p className="text-sophia-text2 mb-4">
        This session recap couldn&apos;t be loaded. It may have expired or been removed.
      </p>
      {onRetry && (
        <div className="mt-4">
          <RetryAction message={errorCopy.recapLoadFailed} onRetry={onRetry} onDismiss={onDismiss} />
        </div>
      )}
    </div>
  );
}
