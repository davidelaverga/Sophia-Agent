/**
 * Loading Skeletons
 * Sprint 1+ - Reduce perceived latency with skeleton UI
 * 
 * Skeletons maintain layout stability and feel faster than spinners.
 * Use shimmer animation for visual interest.
 */

'use client';

import { cn } from '../../lib/utils';

// =============================================================================
// BASE SKELETON
// =============================================================================

interface SkeletonProps {
  className?: string;
  /** Show shimmer animation */
  animate?: boolean;
  /** Inline style */
  style?: React.CSSProperties;
}

export function Skeleton({ className, animate = true, style }: SkeletonProps) {
  return (
    <div
      className={cn(
        'bg-sophia-surface-border/50 rounded',
        animate && 'animate-shimmer bg-gradient-to-r from-sophia-surface-border/50 via-sophia-surface/80 to-sophia-surface-border/50 bg-[length:200%_100%]',
        className
      )}
      style={style}
    />
  );
}

// =============================================================================
// MESSAGE SKELETON (for chat bubbles)
// =============================================================================

interface MessageSkeletonProps {
  /** Which side the message is on */
  side?: 'left' | 'right';
  /** Number of lines to show */
  lines?: number;
  /** Show avatar */
  showAvatar?: boolean;
  className?: string;
}

export function MessageSkeleton({ 
  side = 'left', 
  lines = 2, 
  showAvatar = true,
  className,
}: MessageSkeletonProps) {
  return (
    <div className={cn(
      'flex gap-3 px-4 py-2',
      side === 'right' && 'flex-row-reverse',
      className
    )}>
      {/* Avatar skeleton */}
      {showAvatar && (
        <Skeleton className="w-8 h-8 rounded-full shrink-0" />
      )}
      
      {/* Message bubble skeleton */}
      <div className={cn(
        'flex flex-col gap-2 max-w-[70%]',
        side === 'right' && 'items-end'
      )}>
        <div className={cn(
          'p-4 rounded-2xl space-y-2',
          side === 'left' 
            ? 'bg-sophia-surface rounded-tl-sm' 
            : 'bg-sophia-purple/20 rounded-tr-sm'
        )}>
          {Array.from({ length: lines }).map((_, i) => {
            const widths = [100, 92, 88, 95, 85];
            return (
              <Skeleton
                key={i}
                className={cn(
                  'h-4 rounded-full',
                  i === lines - 1 ? 'w-2/3' : 'w-full'
                )}
                style={{ width: i === lines - 1 ? '60%' : `${widths[i % widths.length]}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// CARD SKELETON (for dashboard cards)
// =============================================================================

interface CardSkeletonProps {
  /** Show icon placeholder */
  showIcon?: boolean;
  /** Number of text lines */
  lines?: number;
  className?: string;
}

export function CardSkeleton({ 
  showIcon = true, 
  lines = 2,
  className,
}: CardSkeletonProps) {
  return (
    <div className={cn(
      'p-4 rounded-xl',
      'bg-sophia-surface border border-sophia-surface-border',
      className
    )}>
      <div className="flex items-start gap-3">
        {showIcon && (
          <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
        )}
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/3 rounded-full" />
          {Array.from({ length: lines }).map((_, i) => {
            const widths = [95, 80, 70, 88, 75];
            return (
              <Skeleton
                key={i}
                className="h-3 rounded-full"
                style={{ width: `${widths[i % widths.length]}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// RITUAL CARD SKELETON (for dashboard ritual cards)
// =============================================================================

export function RitualCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn(
      'w-[140px] p-4 rounded-2xl',
      'bg-sophia-surface border border-sophia-surface-border',
      className
    )}>
      <Skeleton className="w-10 h-10 rounded-xl mb-2" />
      <Skeleton className="h-4 w-3/4 rounded-full mb-1" />
      <Skeleton className="h-3 w-full rounded-full" />
    </div>
  );
}

// =============================================================================
// STAT CARD SKELETON (for recap page)
// =============================================================================

export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn(
      'bg-sophia-surface/50 rounded-xl p-4 border border-sophia-surface-border',
      className
    )}>
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-full shrink-0" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-12 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// TEXT SKELETON (for inline loading)
// =============================================================================

interface TextSkeletonProps {
  /** Width variant */
  width?: 'sm' | 'md' | 'lg' | 'full';
  className?: string;
}

export function TextSkeleton({ width = 'md', className }: TextSkeletonProps) {
  const widthClasses = {
    sm: 'w-16',
    md: 'w-32',
    lg: 'w-48',
    full: 'w-full',
  };
  
  return (
    <Skeleton className={cn('h-4 rounded-full', widthClasses[width], className)} />
  );
}

// =============================================================================
// FULL PAGE SKELETON
// =============================================================================

export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading page" className="min-h-screen bg-sophia-bg p-6 space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Skeleton className="w-10 h-10 rounded-xl" />
        <Skeleton className="w-10 h-10 rounded-xl" />
        <Skeleton className="w-10 h-10 rounded-xl" />
      </div>
      
      {/* Content */}
      <div className="max-w-lg mx-auto space-y-4">
        <Skeleton className="h-8 w-1/2 mx-auto rounded-full" />
        <Skeleton className="h-4 w-1/3 mx-auto rounded-full" />
        
        {/* Cards grid */}
        <div className="grid grid-cols-2 gap-4 mt-8">
          <RitualCardSkeleton />
          <RitualCardSkeleton />
          <RitualCardSkeleton />
          <RitualCardSkeleton />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// CHAT LOADING STATE
// =============================================================================

export function ChatLoadingSkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" className="flex-1 overflow-hidden p-4 space-y-4">
      {/* Assistant messages */}
      <MessageSkeleton side="left" lines={3} />
      <MessageSkeleton side="right" lines={1} showAvatar={false} />
      <MessageSkeleton side="left" lines={2} />
      
      {/* Typing indicator placeholder */}
      <div className="flex items-center gap-2 px-4 py-2">
        <Skeleton className="w-8 h-8 rounded-full" />
        <div className="flex gap-1">
          <Skeleton className="w-2 h-2 rounded-full" />
          <Skeleton className="w-2 h-2 rounded-full" />
          <Skeleton className="w-2 h-2 rounded-full" />
        </div>
      </div>
    </div>
  );
}
