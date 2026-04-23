'use client';

import { ArrowUpRight, Download, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, MouseEventHandler } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';

type BuilderReadyPillProps = {
  title: string;
  onOpen: () => void;
  downloadHref?: string | null;
  onDownload?: MouseEventHandler<HTMLAnchorElement>;
  onDismiss?: () => void;
  isNew?: boolean;
  compact?: boolean;
  /** When >1, the pill badges a multi-file deliverable set (opens the panel for the full library). */
  itemCount?: number;
  className?: string;
};

export function BuilderReadyPill({
  title,
  onOpen,
  downloadHref,
  onDownload,
  onDismiss,
  isNew = false,
  compact = false,
  itemCount,
  className,
}: BuilderReadyPillProps) {
  const handleDismissClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    haptic('selection');
    onDismiss?.();
  };
  const handleOpenClick = () => {
    haptic('light');
    onOpen();
  };
  const handleDownloadClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    haptic('success');
    onDownload?.(event);
  };

  const showCountBadge = typeof itemCount === 'number' && itemCount > 1;
  const pillIdentity = useMemo(
    () => [downloadHref ?? title, itemCount ?? 1].join('::'),
    [downloadHref, itemCount, title],
  );
  const animatedIdentityRef = useRef<string | null>(null);
  const [shouldAnimate, setShouldAnimate] = useState(false);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (isNew && animatedIdentityRef.current !== pillIdentity) {
      animatedIdentityRef.current = pillIdentity;
      setShouldAnimate(true);
      timeoutId = setTimeout(() => setShouldAnimate(false), 420);
    } else if (!isNew) {
      setShouldAnimate(false);
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isNew, pillIdentity]);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border backdrop-blur-md',
        compact
          ? 'w-[min(360px,calc(100vw-28px))] px-3 py-2'
          : 'w-[min(420px,calc(100vw-40px))] px-3.5 py-2.5',
        shouldAnimate && 'animate-[builder-reveal_360ms_ease-out]',
        className,
      )}
      style={{
        borderColor: 'color-mix(in srgb, var(--cosmic-teal) 18%, var(--cosmic-border-soft))',
        background: 'color-mix(in srgb, var(--cosmic-panel) 72%, transparent)',
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                background: 'var(--cosmic-teal)',
                boxShadow: '0 0 8px color-mix(in srgb, var(--cosmic-teal) 50%, transparent)',
              }}
            />
            <span
              className="text-[10px] tracking-[0.16em] lowercase"
              style={{ color: 'var(--cosmic-text-whisper)' }}
            >
              {isNew ? 'deliverable complete' : 'deliverable ready'}
            </span>
            <span
              className="rounded-full px-1.5 py-[1px] text-[9px] tabular-nums tracking-[0.08em] lowercase"
              style={{
                color: 'var(--cosmic-teal)',
                background: 'color-mix(in srgb, var(--cosmic-teal) 12%, transparent)',
              }}
            >
              100%
            </span>
            {showCountBadge && (
              <span
                className="rounded-full px-1.5 py-[1px] text-[9px] tabular-nums tracking-[0.08em] lowercase"
                style={{
                  color: 'var(--sophia-purple)',
                  background: 'color-mix(in srgb, var(--sophia-purple) 12%, transparent)',
                }}
                title={`${itemCount} deliverables in this session`}
              >
                {itemCount} files
              </span>
            )}
          </div>

          <div className={cn('mt-1.5 grid min-w-0 items-center gap-2', compact ? 'grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]')}>
            <button
              type="button"
              onClick={handleOpenClick}
              className="min-w-0 text-left"
            >
              <p
                className={cn('truncate tracking-[0.02em]', compact ? 'text-[11px]' : 'text-[12px]')}
                style={{ color: 'var(--cosmic-text)' }}
                title={title}
              >
                {title}
              </p>
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={handleOpenClick}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border tracking-[0.08em] lowercase transition-colors duration-200 hover:bg-white/[0.04]',
                  compact ? 'px-2 py-[3px] text-[9px]' : 'px-2.5 py-1 text-[10px]',
                )}
                style={{
                  borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 80%, transparent)',
                  color: 'var(--cosmic-text-whisper)',
                  background: 'transparent',
                }}
              >
                <ArrowUpRight className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
                open
              </button>

              {downloadHref && (
                <a
                  href={downloadHref}
                  onClick={handleDownloadClick}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border tracking-[0.08em] lowercase transition-colors duration-200 hover:bg-white/[0.04]',
                    compact ? 'px-2 py-[3px] text-[9px]' : 'px-2.5 py-1 text-[10px]',
                  )}
                  style={{
                    borderColor: 'color-mix(in srgb, var(--sophia-purple) 22%, var(--cosmic-border-soft))',
                    color: 'var(--sophia-purple)',
                    background: 'color-mix(in srgb, var(--sophia-purple) 6%, transparent)',
                  }}
                >
                  <Download className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
                  download
                </a>
              )}
            </div>
          </div>
        </div>

        {onDismiss && (
          <button
            type="button"
            onClick={handleDismissClick}
            aria-label="Dismiss deliverable"
            className={cn(
              "relative mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-white/[0.04] before:absolute before:content-['']",
              'before:-inset-[12px]',
            )}
            style={{ color: 'var(--cosmic-text-faint)' }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}