'use client';

import { MessageSquare, Sparkles } from 'lucide-react';
import { haptic } from '../../hooks/useHaptics';
import { TAG_LABELS } from '../../lib/recap-types';
import { cn } from '../../lib/utils';

interface TakeawayCardProps {
  takeaway?: string;
  isLoading?: boolean;
  className?: string;
}

export function TakeawayCard({ takeaway, isLoading, className }: TakeawayCardProps) {
  if (isLoading) {
    return (
      <div className={cn(
        'bg-sophia-surface rounded-2xl p-6 border border-sophia-surface-border',
        className
      )}>
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-sophia-purple animate-pulse" />
          <span className="text-sophia-text2 text-sm">Generating takeaway...</span>
        </div>
        <div className="space-y-2">
          <div className="h-4 bg-sophia-surface-border rounded animate-pulse w-3/4" />
          <div className="h-4 bg-sophia-surface-border rounded animate-pulse w-1/2" />
        </div>
      </div>
    );
  }

  if (!takeaway) {
    return (
      <div className={cn(
        'bg-sophia-surface/50 rounded-2xl p-6 border border-dashed border-sophia-surface-border',
        className
      )}>
        <div className="flex items-center gap-3 text-sophia-text2">
          <Sparkles className="w-5 h-5 opacity-50" />
          <div>
            <p className="font-medium">Your takeaway will appear here</p>
            <p className="text-sm opacity-70">Once the session completes</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      'bg-gradient-to-br from-sophia-surface to-sophia-surface/80 rounded-2xl p-8 border border-sophia-purple/20',
      'shadow-soft',
      className
    )}>
      <div className="flex items-center gap-2.5 mb-5">
        <span className="text-2xl">✨</span>
        <h2 className="text-lg font-semibold text-sophia-text">Key Takeaway</h2>
      </div>
      <p className="text-sophia-text leading-relaxed text-xl font-medium">
        {takeaway}
      </p>
    </div>
  );
}

interface ReflectionCardProps {
  prompt?: string;
  tag?: string;
  onReflect?: () => void;
  isLoading?: boolean;
  className?: string;
}

export function ReflectionCard({ prompt, tag, onReflect, isLoading, className }: ReflectionCardProps) {
  if (isLoading) {
    return (
      <div className={cn(
        'bg-sophia-surface rounded-2xl p-6 border border-sophia-surface-border',
        className
      )}>
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="w-5 h-5 text-sophia-purple animate-pulse" />
          <span className="text-sophia-text2 text-sm">Preparing reflection...</span>
        </div>
        <div className="h-4 bg-sophia-surface-border rounded animate-pulse w-2/3" />
      </div>
    );
  }

  if (!prompt) {
    return (
      <div className={cn(
        'bg-sophia-surface/50 rounded-2xl p-6 border border-dashed border-sophia-surface-border',
        className
      )}>
        <div className="flex items-center gap-3 text-sophia-text2">
          <MessageSquare className="w-5 h-5 opacity-50" />
          <div>
            <p className="font-medium">Reflection prompt will appear here</p>
            <p className="text-sm opacity-70">Based on your conversation</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      'bg-sophia-surface rounded-2xl p-7 border border-sophia-surface-border',
      className
    )}>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">💭</span>
          <h2 className="text-lg font-semibold text-sophia-text">Something to Reflect On</h2>
        </div>
        {tag && (
          <span className="px-2.5 py-1 text-xs font-medium bg-sophia-purple/10 text-sophia-purple rounded-full">
            {TAG_LABELS[tag] || tag}
          </span>
        )}
      </div>

      <p className="text-sophia-text2 text-base leading-relaxed mb-5">
        &ldquo;{prompt}&rdquo;
      </p>

      {onReflect && (
        <button
          onClick={() => {
            haptic('light');
            onReflect();
          }}
          className={cn(
            'px-4 py-2.5 text-sm font-medium rounded-xl',
            'bg-sophia-purple/10 text-sophia-purple hover:bg-sophia-purple/20',
            'transition-colors'
          )}
        >
          Sit with this for a moment →
        </button>
      )}
    </div>
  );
}
