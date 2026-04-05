'use client';

import { Brain, Check, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';

interface RecapMemoryCandidatesIntroProps {
  candidatesCount: number;
}

export function RecapMemoryCandidatesIntro({ candidatesCount }: RecapMemoryCandidatesIntroProps) {
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">🧠</span>
          <h2 className="text-lg font-semibold text-sophia-text">Memory Candidates</h2>
          <span className="px-2 py-0.5 text-xs bg-sophia-surface-border rounded-full text-sophia-text2">
            {candidatesCount}
          </span>
        </div>
      </div>

      <div className="mb-5 px-4 py-3 bg-sophia-purple/5 border border-sophia-purple/10 rounded-xl">
        <p className="text-sm text-sophia-text2">
          Sophia suggests a few memories you might want to keep. <strong className="text-sophia-text">You&apos;re always in control.</strong>
        </p>
      </div>
    </>
  );
}

interface RecapMemoryCandidatesLoadingStateProps {
  className?: string;
}

export function RecapMemoryCandidatesLoadingState({ className }: RecapMemoryCandidatesLoadingStateProps) {
  return (
    <div className={cn(
      'bg-sophia-surface rounded-2xl p-6 border border-sophia-surface-border',
      className
    )}>
      <div className="flex items-center gap-2 mb-4">
        <Brain className="w-5 h-5 text-sophia-purple animate-pulse" />
        <span className="text-sophia-text2 text-sm">Analyzing memories...</span>
      </div>
      <div className="space-y-3">
        {[1, 2].map(i => (
          <div key={i} className="h-20 bg-sophia-surface-border/50 rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  );
}

interface RecapMemoryCandidatesNoDataStateProps {
  className?: string;
}

export function RecapMemoryCandidatesNoDataState({ className }: RecapMemoryCandidatesNoDataStateProps) {
  return (
    <div className={cn(
      'bg-sophia-surface/50 rounded-2xl p-6 border border-dashed border-sophia-surface-border',
      className
    )}>
      <div className="flex items-center gap-3 text-sophia-text2">
        <Brain className="w-5 h-5 opacity-50" />
        <div>
          <p className="font-medium">No high-signal memories detected</p>
          <p className="text-sm opacity-70">That&apos;s good — Sophia only saves what truly helps</p>
        </div>
      </div>
    </div>
  );
}

interface RecapMemoryCandidatesFooterProps {
  approvedCount: number;
  onSaveApproved?: () => void;
  isSaving?: boolean;
}

export function RecapMemoryCandidatesFooter({
  approvedCount,
  onSaveApproved,
  isSaving,
}: RecapMemoryCandidatesFooterProps) {
  if (!onSaveApproved || approvedCount <= 0) {
    return null;
  }

  return (
    <div className="mt-6 pt-4 border-t border-sophia-surface-border">
      <div className="flex items-center justify-between">
        <p className="text-sm text-sophia-text2/60">
          {approvedCount} {approvedCount === 1 ? 'memory' : 'memories'} ready to save
        </p>
        <button
          onClick={() => {
            haptic('medium');
            onSaveApproved();
          }}
          disabled={isSaving}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-xl transition-all',
            'bg-sophia-purple/80 text-sophia-bg hover:bg-sophia-purple/85',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'flex items-center gap-2'
          )}
        >
          {isSaving ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              Save Approved Memories
            </>
          )}
        </button>
      </div>
    </div>
  );
}
