'use client';

import { ArrowUpRight, Download, X } from 'lucide-react';
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
  return (
    <div
      className={cn(
        compact
          ? 'relative w-[min(312px,calc(100vw-40px))] overflow-hidden rounded-[20px] border px-3 py-2 backdrop-blur-xl'
          : 'relative w-[min(360px,calc(100vw-48px))] overflow-hidden rounded-[22px] border px-3.5 py-2.5 backdrop-blur-xl',
        isNew && `animate-[builder-ready-pill-enter_${compact ? '540ms' : '700ms'}_cubic-bezier(0.22,1,0.36,1)]`,
        className,
      )}
      style={{
        borderColor: 'color-mix(in srgb, var(--sophia-purple) 22%, var(--cosmic-border-soft))',
        background: compact
          ? 'linear-gradient(180deg, color-mix(in srgb, var(--sophia-purple) 6%, color-mix(in srgb, var(--cosmic-panel-soft) 62%, transparent)), color-mix(in srgb, var(--cosmic-panel) 58%, transparent))'
          : 'linear-gradient(180deg, color-mix(in srgb, var(--sophia-purple) 10%, var(--cosmic-panel-soft)), color-mix(in srgb, var(--cosmic-panel) 88%, transparent))',
        boxShadow: isNew
          ? '0 14px 36px color-mix(in srgb, var(--sophia-purple) 16%, transparent)'
          : '0 10px 26px color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
      }}
    >
      <div
        className={cn(
          'pointer-events-none absolute inset-x-3 overflow-hidden rounded-full border',
          compact ? 'bottom-1.5 h-1' : 'bottom-2 h-1.5',
        )}
        style={{
          borderColor: 'color-mix(in srgb, var(--sophia-purple) 24%, transparent)',
          background: 'color-mix(in srgb, var(--cosmic-panel-soft) 72%, transparent)',
        }}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 w-full origin-left rounded-full',
            isNew ? `animate-[builder-pill-fill_${compact ? '720ms' : '900ms'}_cubic-bezier(0.22,1,0.36,1)_1]` : 'scale-x-100',
          )}
          style={{
            background: 'linear-gradient(90deg, color-mix(in srgb, var(--sophia-purple) 72%, white 8%), color-mix(in srgb, var(--cosmic-teal) 66%, var(--sophia-purple) 34%))',
            boxShadow: '0 0 18px color-mix(in srgb, var(--sophia-purple) 18%, transparent)',
          }}
        >
          <div
            className="absolute inset-y-0 left-[-45%] w-[45%]"
            style={{
              background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.52), transparent)',
              animation: isNew
                ? `builder-progress-sheen ${compact ? '900ms' : '1.05s'} linear 180ms 2`
                : 'builder-progress-sheen 2.4s linear infinite',
            }}
          />
        </div>
      </div>

      <div
        className={cn(
          'pointer-events-none absolute rounded-full',
          compact ? 'right-3 top-2.5 h-12 w-12' : 'right-4 top-3 h-16 w-16',
        )}
        style={{
          background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 24%, transparent) 0%, transparent 72%)',
          opacity: isNew ? 0.95 : 0.55,
          animation: isNew ? 'builder-ready-aura 1.8s ease-in-out infinite' : undefined,
        }}
      />

      <div className={cn('relative flex items-center pr-1', compact ? 'gap-2' : 'gap-2.5')}>
        <button
          type="button"
          onClick={handleOpenClick}
          className="min-w-0 flex-1 text-left transition-opacity hover:opacity-100"
          style={{ opacity: 0.98 }}
        >
          <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                isNew && 'animate-[builder-ready-dot_1.4s_ease-in-out_infinite]',
              )}
              style={{
                background: 'var(--cosmic-teal)',
                boxShadow: '0 0 10px color-mix(in srgb, var(--cosmic-teal) 42%, transparent)',
              }}
            />
            <span className={cn(compact ? 'text-[9px]' : 'text-[10px]', 'tracking-[0.14em] lowercase')} style={{ color: 'var(--cosmic-text-whisper)' }}>
              {isNew ? 'deliverable complete' : 'deliverable ready'}
            </span>
            <span
              className={cn('rounded-full tracking-[0.1em] lowercase', compact ? 'px-1.5 py-0.5 text-[8px]' : 'px-2 py-0.5 text-[9px]')}
              style={{
                color: 'var(--cosmic-teal)',
                background: 'color-mix(in srgb, var(--cosmic-teal) 14%, transparent)',
              }}
            >
              100%
            </span>
            {showCountBadge && (
              <span
                className={cn('rounded-full tracking-[0.1em] lowercase', compact ? 'px-1.5 py-0.5 text-[8px]' : 'px-2 py-0.5 text-[9px]')}
                style={{
                  color: 'var(--sophia-purple)',
                  background: 'color-mix(in srgb, var(--sophia-purple) 16%, transparent)',
                }}
                title={`${itemCount} deliverables in this session`}
              >
                {itemCount} files
              </span>
            )}
          </div>

          <p className={cn(compact ? 'mt-0.5 text-[11px]' : 'mt-1 text-[12px]', 'truncate tracking-[0.03em]')} style={{ color: 'var(--cosmic-text)' }}>
            {title}
          </p>
        </button>

        <div className={cn('flex shrink-0 items-center gap-1.5', compact ? 'pb-1.5' : 'pb-2')}>
          <button
            type="button"
            onClick={handleOpenClick}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border tracking-[0.08em] lowercase transition-opacity hover:opacity-100',
              compact ? 'px-2 py-0.5 text-[9px]' : 'px-2.5 py-1 text-[10px]',
            )}
            style={{
              borderColor: 'color-mix(in srgb, var(--sophia-purple) 18%, var(--cosmic-border-soft))',
              color: 'var(--cosmic-text-whisper)',
              background: 'color-mix(in srgb, var(--cosmic-panel-soft) 72%, transparent)',
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
                'inline-flex items-center gap-1 rounded-full border tracking-[0.08em] lowercase transition-opacity hover:opacity-100',
                compact ? 'px-2 py-0.5 text-[9px]' : 'px-2.5 py-1 text-[10px]',
              )}
              style={{
                borderColor: 'color-mix(in srgb, var(--sophia-purple) 24%, var(--cosmic-border-soft))',
                color: 'var(--sophia-purple)',
                background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
              }}
            >
              <Download className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
              download
            </a>
          )}

          {onDismiss && (
            <button
              type="button"
              onClick={handleDismissClick}
              aria-label="Dismiss deliverable"
              // Visual footprint stays minimal (compact 20px / regular 24px), but the
              // ::before extends a full 44×44 tap area on touch devices so mobile taps
              // don't miss and accidentally re-open the pill.
              className={cn(
                'relative inline-flex items-center justify-center rounded-full border transition-opacity hover:opacity-100',
                "before:absolute before:content-['']",
                compact
                  ? 'h-5 w-5 before:-inset-[12px]'
                  : 'h-6 w-6 before:-inset-[10px]',
              )}
              style={{
                borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 88%, transparent)',
                color: 'var(--cosmic-text-whisper)',
                background: 'color-mix(in srgb, var(--cosmic-panel-soft) 52%, transparent)',
                opacity: 0.78,
              }}
            >
              <X className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}