'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { MemoryCandidateV1 } from '../../lib/recap-types';

interface RecapMemoryOrbitNavigationProps {
  activeCandidates: MemoryCandidateV1[];
  focusedIndex: number;
  disabled?: boolean;
  isExiting: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSelectIndex: (index: number) => void;
}

export function RecapMemoryOrbitNavigation({
  activeCandidates,
  focusedIndex,
  disabled,
  isExiting,
  onPrev,
  onNext,
  onSelectIndex,
}: RecapMemoryOrbitNavigationProps) {
  if (activeCandidates.length <= 1) {
    return null;
  }

  return (
    <>
      <button
        onClick={onPrev}
        disabled={disabled || isExiting}
        className={cn(
          'absolute left-2 sm:left-6 lg:left-12 top-1/2 -translate-y-1/2 z-30',
          'w-10 h-10 rounded-full',
          'flex items-center justify-center',
          'text-sophia-text2/30 hover:text-sophia-text2/60',
          'transition-all duration-300',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/30',
          'disabled:opacity-20 disabled:cursor-not-allowed'
        )}
        aria-label="Previous memory"
      >
        <ChevronLeft className="w-8 h-8" strokeWidth={1.5} />
      </button>

      <button
        onClick={onNext}
        disabled={disabled || isExiting}
        className={cn(
          'absolute right-2 sm:right-6 lg:right-12 top-1/2 -translate-y-1/2 z-30',
          'w-10 h-10 rounded-full',
          'flex items-center justify-center',
          'text-sophia-text2/30 hover:text-sophia-text2/60',
          'transition-all duration-300',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/30',
          'disabled:opacity-20 disabled:cursor-not-allowed'
        )}
        aria-label="Next memory"
      >
        <ChevronRight className="w-8 h-8" strokeWidth={1.5} />
      </button>

      <div className="flex items-center justify-center gap-2 mt-6" role="tablist">
        {activeCandidates.map((candidate, index) => (
          <button
            key={candidate.id}
            onClick={() => onSelectIndex(index)}
            disabled={disabled || isExiting}
            className={cn(
              'w-2 h-2 rounded-full transition-all duration-500',
              index === focusedIndex
                ? 'w-8 bg-sophia-purple/80'
                : 'bg-sophia-surface-border/50 hover:bg-sophia-purple/30'
            )}
            role="tab"
            aria-selected={index === focusedIndex}
            aria-label={`Memory ${index + 1}`}
          />
        ))}
      </div>
    </>
  );
}
