'use client';

import { RefreshCw, Sparkles } from 'lucide-react';

import { errorCopy } from '../../lib/error-copy';
import { cn } from '../../lib/utils';
import { RetryAction } from '../ui/RetryAction';

type RecapEmptyStatus = 'processing' | 'reviewed' | 'no_pending' | 'source_excluded' | 'unavailable' | 'not_found';

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
          We couldn&apos;t verify this recap. No memory candidates are shown. Please try again.
        </p>
      </div>
    );
  }

  if (status === 'source_excluded') {
    return (
      <div role="status" className={cn('bg-sophia-surface rounded-2xl p-8 text-center border border-sophia-surface-border', className)}>
        <h3 className="text-lg font-medium text-sophia-text mb-2">Session source is excluded from memory extraction</h3>
        <p className="text-sophia-text2 mb-4">
          This transcript is preserved, but its source is from before a memory clear or no longer has valid acceptance.
          This is not a completed extraction with zero candidates. Nothing has been approved automatically.
        </p>
      </div>
    );
  }

  if (status === 'reviewed' || status === 'no_pending') {
    return (
      <div className={cn(
        'bg-sophia-surface rounded-2xl p-8 text-center border border-sophia-surface-border',
        className
      )}>
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-sophia-purple/10 flex items-center justify-center">
          <Sparkles className="w-6 h-6 text-sophia-purple" />
        </div>
        <h3 className="text-lg font-medium text-sophia-text mb-2">
          {status === 'reviewed' ? 'Memories already reviewed' : 'No candidates currently eligible for review'}
        </h3>
        <p className="text-sophia-text2 mb-4">
          {status === 'reviewed'
            ? 'The candidates from this session have already been approved or discarded. This does not confirm their current saved status.'
            : 'This session produced candidates, but some have expired or are no longer eligible. Nothing has been approved automatically.'}
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
