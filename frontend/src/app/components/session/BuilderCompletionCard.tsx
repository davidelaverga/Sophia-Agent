'use client';

import { Download, ExternalLink, Eye } from 'lucide-react';
import { useMemo, type MouseEventHandler } from 'react';

import { buildThreadArtifactHref } from '../../lib/builder-artifacts';
import { cn } from '../../lib/utils';
import type { BuilderCompletionEventV1 } from '../../types/builder-completion';

type StatusMeta = {
  label: string;
  accentVar: string;
  icon: 'check' | 'warn' | 'pause';
};

const STATUS_META: Record<BuilderCompletionEventV1['status'], StatusMeta> = {
  success:   { label: 'ready',     accentVar: 'var(--cosmic-teal)',                   icon: 'check' },
  error:     { label: 'failed',    accentVar: 'var(--sophia-error, #f87171)',         icon: 'warn'  },
  timeout:   { label: 'timed out', accentVar: 'var(--cosmic-amber)',                  icon: 'warn'  },
  cancelled: { label: 'cancelled', accentVar: 'var(--cosmic-text-faint, #a1a1aa)',    icon: 'pause' },
};

const FAILURE_BODY =
  'Sorry it seems like the task didn’t complete. Do you want me to try again?';
const TIMEOUT_BODY =
  'The build took longer than expected and was cut short. Want me to try again?';
const CANCELLED_BODY = 'Build was cancelled. Let me know when you want to pick it up again.';
const DOWNLOAD_FIRST_EXTENSIONS = new Set(['pptx', 'ppt', 'docx', 'xlsx']);

type BuilderCompletionCardProps = {
  event: BuilderCompletionEventV1;
  onOpen?: (event: BuilderCompletionEventV1) => void;
  /**
   * Optional secondary action invoked when the user clicks the Download
   * button on a success card. Receives the same event so the host can
   * drive analytics / haptics / dismiss-on-download. The actual download
   * is triggered by the underlying anchor's ``download`` attribute, so
   * the host does NOT need to perform the file fetch itself.
   */
  onDownload?: (event: BuilderCompletionEventV1) => void;
  onRetry?: (event: BuilderCompletionEventV1) => void;
  onDismiss?: (event: BuilderCompletionEventV1) => void;
  compact?: boolean;
  className?: string;
};

function StatusGlyph({ icon, accentVar, compact }: { icon: StatusMeta['icon']; accentVar: string; compact?: boolean }) {
  const size = compact ? 'h-9 w-9' : 'h-10 w-10';
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center rounded-full border', size)}
      style={{
        borderColor: `color-mix(in srgb, ${accentVar} 32%, transparent)`,
        background: `color-mix(in srgb, ${accentVar} 10%, transparent)`,
        boxShadow: `0 0 18px color-mix(in srgb, ${accentVar} 18%, transparent)`,
      }}
      aria-hidden
    >
      {icon === 'check' && (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke={accentVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.5 3.5L13 5" />
        </svg>
      )}
      {icon === 'warn' && (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke={accentVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 4v5" />
          <path d="M8 11.5h.01" />
          <circle cx="8" cy="8" r="6" />
        </svg>
      )}
      {icon === 'pause' && (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke={accentVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4v8" />
          <path d="M10 4v8" />
        </svg>
      )}
    </div>
  );
}

function deriveTitle(event: BuilderCompletionEventV1): string {
  if (event.status === 'success') {
    if (isFallbackCompletion(event)) {
      return `${fallbackArtifactLabel(event)} ready.`;
    }
    return event.artifact_title || event.artifact_filename || (event.artifact_path || event.artifact_url ? 'Your file is ready.' : 'Artifact delivery is pending.');
  }
  if (event.status === 'timeout') {
    return 'Build timed out';
  }
  if (event.status === 'cancelled') {
    return 'Build cancelled';
  }
  return 'Build didn’t complete';
}

function deriveBody(event: BuilderCompletionEventV1): string | null {
  if (event.status === 'success') {
    if (isFallbackCompletion(event)) {
      return fallbackCompletionBody(event);
    }
    return event.summary || event.user_next_action || null;
  }
  if (event.status === 'error') {
    return event.error_message || diagnosticFailureBody(event) || FAILURE_BODY;
  }
  if (event.status === 'timeout') {
    return TIMEOUT_BODY;
  }
  return CANCELLED_BODY;
}

function diagnosticFailureBody(event: BuilderCompletionEventV1): string | null {
  const code = event.builder_failure_diagnostics?.failure_code;
  switch (code) {
    case 'artifact_file_missing':
    case 'html_artifact_missing':
      return 'Builder failed: artifact file was missing.';
    case 'supporting_file_missing':
      return 'Builder failed: a supporting file was missing.';
    case 'builder_completed_without_deliverable':
      return 'Builder finished without a deliverable artifact.';
    case 'html_invalid_artifact_extension':
      return 'Builder rejected HTML output because it was not a standalone .html file.';
    case 'html_markdown_fence':
      return 'Builder rejected HTML output because it was wrapped in Markdown fences.';
    case 'html_escaped_as_text':
      return 'Builder rejected HTML output because HTML was escaped as text.';
    case 'html_missing_standalone_structure':
      return 'Builder rejected HTML output because it was not a standalone HTML document.';
    default:
      return event.builder_failure_diagnostics?.failure_reason ?? null;
  }
}

function artifactExtension(event: BuilderCompletionEventV1): string {
  if (event.artifact_ext) {
    return event.artifact_ext.toLowerCase().replace(/^\./u, '');
  }
  const candidate = event.artifact_filename || event.artifact_path || event.artifact_url || '';
  const clean = candidate.split('?')[0]?.split('#')[0] ?? '';
  const ext = clean.split('.').pop();
  return ext && ext !== clean ? ext.toLowerCase() : '';
}

function isDownloadFirstArtifact(event: BuilderCompletionEventV1): boolean {
  return DOWNLOAD_FIRST_EXTENSIONS.has(artifactExtension(event));
}

function isFallbackCompletion(event: BuilderCompletionEventV1): boolean {
  return event.status === 'success' && event.artifact_is_fallback === true;
}

function fallbackArtifactLabel(event: BuilderCompletionEventV1): string {
  const ext = artifactExtension(event);
  if (ext === 'html' || ext === 'htm') {
    return 'HTML fallback';
  }
  if (ext === 'md' || ext === 'markdown') {
    return 'Markdown fallback';
  }
  return `${ext ? ext.toUpperCase() : 'Artifact'} fallback`;
}

function fallbackCompletionBody(event: BuilderCompletionEventV1): string {
  const requested = event.requested_artifact_ext?.toLowerCase().replace(/^\./u, '') ?? '';
  const ext = artifactExtension(event);
  if (requested === 'pptx' && (ext === 'html' || ext === 'htm')) {
    return 'I couldn’t finish the PowerPoint package, so I delivered a browser-viewable HTML fallback.';
  }
  if (requested === 'pptx' && (ext === 'md' || ext === 'markdown')) {
    return 'I couldn’t finish the PowerPoint package, so I delivered a Markdown fallback you can open and reuse.';
  }
  return event.summary || 'I delivered a usable fallback artifact because the originally requested format could not be completed.';
}

export function getBuilderCompletionFallbackLabel(event: BuilderCompletionEventV1): string | null {
  return isFallbackCompletion(event) ? fallbackArtifactLabel(event).toLowerCase() : null;
}

export function getBuilderCompletionFallbackBody(event: BuilderCompletionEventV1): string | null {
  return isFallbackCompletion(event) ? fallbackCompletionBody(event) : null;
}

export function BuilderCompletionCard({
  event,
  onOpen,
  onDownload,
  onRetry,
  onDismiss,
  compact = false,
  className,
}: BuilderCompletionCardProps) {
  const meta = STATUS_META[event.status];
  const title = useMemo(() => deriveTitle(event), [event]);
  const body = useMemo(() => deriveBody(event), [event]);
  const artifactProxyHref = useMemo(
    () => buildThreadArtifactHref(event.thread_id, event.artifact_path),
    [event.artifact_path, event.thread_id],
  );
  const artifactProxyDownloadHref = useMemo(
    () => buildThreadArtifactHref(event.thread_id, event.artifact_path, { download: true }),
    [event.artifact_path, event.thread_id],
  );
  const fallbackLabel = isFallbackCompletion(event) ? fallbackArtifactLabel(event).toLowerCase() : null;
  const showMissingActionHint = shouldShowMissingActionHint({
    event,
    artifactProxyHref,
    artifactProxyDownloadHref,
    hasPreviewHandler: Boolean(onOpen),
  });
  const showDismiss = Boolean(onDismiss);

  const handleDismiss: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    onDismiss?.(event);
  };

  return (
    <div
      role="status"
      aria-live="assertive"
      data-testid="builder-completion-card"
      data-status={event.status}
      className={cn(
        compact
          ? 'w-[min(340px,calc(100vw-40px))] rounded-[20px] border px-3 py-2.5 backdrop-blur-xl transition-all duration-500 animate-[builder-reveal_0.45s_ease-out]'
          : 'w-[min(360px,calc(100vw-48px))] rounded-[22px] border px-3.5 py-3 backdrop-blur-xl transition-all duration-700 animate-[builder-reveal_0.6s_ease-out]',
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 24%, var(--cosmic-border-soft))`,
        background: 'color-mix(in srgb, var(--cosmic-panel) 86%, transparent)',
        boxShadow: `0 16px 36px color-mix(in srgb, ${meta.accentVar} 10%, transparent)`,
      }}
    >
      <div className={cn('flex items-start', compact ? 'gap-2.5' : 'gap-3')}>
        <StatusGlyph icon={meta.icon} accentVar={meta.accentVar} compact={compact} />

        <div className="min-w-0 flex-1">
          <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
            <span
              className={cn(compact ? 'text-[9px]' : 'text-[10px]', 'tracking-[0.14em] lowercase')}
              style={{ color: 'var(--cosmic-text-whisper)' }}
            >
              {meta.label}
            </span>
            <span
              className={cn('rounded-full tracking-[0.1em] lowercase', compact ? 'px-1.5 py-0.5 text-[8px]' : 'px-2 py-0.5 text-[9px]')}
              style={{
                color: meta.accentVar,
                background: `color-mix(in srgb, ${meta.accentVar} 12%, transparent)`,
              }}
            >
              builder
            </span>
            {fallbackLabel && (
              <span
                className={cn('rounded-full tracking-[0.1em] lowercase', compact ? 'px-1.5 py-0.5 text-[8px]' : 'px-2 py-0.5 text-[9px]')}
                style={{
                  color: 'var(--cosmic-amber)',
                  background: 'color-mix(in srgb, var(--cosmic-amber) 13%, transparent)',
                }}
              >
                {fallbackLabel}
              </span>
            )}
          </div>

          <p
            className={cn(
              compact ? 'mt-0.5 text-[12px] leading-5' : 'mt-1 text-[13px] leading-5.5',
              'truncate font-medium',
            )}
            style={{ color: 'var(--cosmic-text-strong)' }}
            title={title}
          >
            {title}
          </p>

          {body && (
            <p
              className={cn(compact ? 'mt-1 text-[10px] leading-4.5' : 'mt-1 text-[11px] leading-5')}
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              {body}
            </p>
          )}

          {event.task_brief && event.status !== 'success' && (
            <p
              className={cn(compact ? 'mt-1 text-[9px] leading-4' : 'mt-1.5 text-[10px] leading-4.5', 'italic line-clamp-2')}
              style={{ color: 'var(--cosmic-text-whisper)' }}
              title={event.task_brief}
            >
              about: {event.task_brief}
            </p>
          )}

          {showMissingActionHint && (
            <p
              className={cn(compact ? 'mt-1 text-[9px] leading-4' : 'mt-1.5 text-[10px] leading-4.5')}
              style={{ color: 'var(--cosmic-text-whisper)' }}
            >
              Artifact metadata has not reached this tab yet. I will keep checking the library.
            </p>
          )}
        </div>
      </div>

      <div className={cn('flex items-center justify-end gap-2', compact ? 'mt-2' : 'mt-2.5')}>
        <BuilderCompletionActions
          event={event}
          meta={meta}
          compact={compact}
          artifactProxyHref={artifactProxyHref}
          artifactProxyDownloadHref={artifactProxyDownloadHref}
          onOpen={onOpen}
          onDownload={onDownload}
          onRetry={onRetry}
        />
        {showDismiss && (
          <button
            type="button"
            onClick={handleDismiss}
            className="transition-all duration-300"
            style={{ color: 'var(--cosmic-text-faint)' }}
            aria-label="Dismiss"
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function BuilderCompletionActions({
  event,
  meta,
  compact,
  artifactProxyHref,
  artifactProxyDownloadHref,
  onOpen,
  onDownload,
  onRetry,
}: {
  event: BuilderCompletionEventV1;
  meta: StatusMeta;
  compact: boolean;
  artifactProxyHref: string | null;
  artifactProxyDownloadHref: string | null;
  onOpen?: (event: BuilderCompletionEventV1) => void;
  onDownload?: (event: BuilderCompletionEventV1) => void;
  onRetry?: (event: BuilderCompletionEventV1) => void;
}) {
  const openHref = artifactProxyHref || event.artifact_url || null;
  const downloadHref = artifactProxyDownloadHref || event.artifact_url || null;
  const downloadFirst = isDownloadFirstArtifact(event);

  return (
    <>
      <PreviewAction event={event} href={artifactProxyHref} downloadFirst={downloadFirst} meta={meta} compact={compact} onOpen={onOpen} />
      <OpenAction event={event} href={openHref} downloadFirst={downloadFirst} meta={meta} compact={compact} />
      <DownloadAction event={event} href={downloadHref} meta={meta} compact={compact} onDownload={onDownload} />
      <RetryAction event={event} meta={meta} compact={compact} onRetry={onRetry} />
    </>
  );
}

function PreviewAction({
  event,
  href,
  downloadFirst,
  meta,
  compact,
  onOpen,
}: {
  event: BuilderCompletionEventV1;
  href: string | null;
  downloadFirst: boolean;
  meta: StatusMeta;
  compact: boolean;
  onOpen?: (event: BuilderCompletionEventV1) => void;
}) {
  if (event.status !== 'success' || !href || downloadFirst || !onOpen) {
    return null;
  }
  const handlePreview: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    onOpen(event);
  };
  return (
    <button
      type="button"
      onClick={handlePreview}
      className={cn(
        'rounded-full border tracking-[0.08em] transition-all duration-300',
        compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1 text-[10px]',
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 38%, transparent)`,
        background: `color-mix(in srgb, ${meta.accentVar} 14%, transparent)`,
        color: meta.accentVar,
      }}
    >
      <span className="inline-flex items-center gap-1">
        <Eye className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
        View in canvas
      </span>
    </button>
  );
}

function OpenAction({
  event,
  href,
  downloadFirst,
  meta,
  compact,
}: {
  event: BuilderCompletionEventV1;
  href: string | null;
  downloadFirst: boolean;
  meta: StatusMeta;
  compact: boolean;
}) {
  if (event.status !== 'success' || !href || downloadFirst) {
    return null;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'rounded-full border tracking-[0.08em] transition-all duration-300',
        compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1 text-[10px]',
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 24%, transparent)`,
        background: 'transparent',
        color: 'var(--cosmic-text-faint)',
        textDecoration: 'none',
      }}
      aria-label="Open artifact in new tab"
    >
      <span className="inline-flex items-center gap-1">
        <ExternalLink className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
        Open in new tab
      </span>
    </a>
  );
}

function DownloadAction({
  event,
  href,
  meta,
  compact,
  onDownload,
}: {
  event: BuilderCompletionEventV1;
  href: string | null;
  meta: StatusMeta;
  compact: boolean;
  onDownload?: (event: BuilderCompletionEventV1) => void;
}) {
  if (event.status !== 'success' || !href) {
    return null;
  }
  const handleDownload: MouseEventHandler<HTMLAnchorElement> = () => {
    onDownload?.(event);
  };
  return (
    <a
      href={href}
      download={event.artifact_filename || true}
      onClick={handleDownload}
      className={cn(
        'rounded-full border tracking-[0.08em] transition-all duration-300',
        compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1 text-[10px]',
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 28%, transparent)`,
        background: 'transparent',
        color: 'var(--cosmic-text-faint)',
        textDecoration: 'none',
      }}
      aria-label="Download artifact"
    >
      <span className="inline-flex items-center gap-1">
        <Download className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
        Download
      </span>
    </a>
  );
}

function RetryAction({
  event,
  meta,
  compact,
  onRetry,
}: {
  event: BuilderCompletionEventV1;
  meta: StatusMeta;
  compact: boolean;
  onRetry?: (event: BuilderCompletionEventV1) => void;
}) {
  if (event.status !== 'error' && event.status !== 'timeout') {
    return null;
  }
  const handleRetry: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    onRetry?.(event);
  };
  return (
    <button
      type="button"
      onClick={handleRetry}
      className={cn(
        'rounded-full border tracking-[0.08em] lowercase transition-all duration-300',
        compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1 text-[10px]',
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.accentVar} 38%, transparent)`,
        background: `color-mix(in srgb, ${meta.accentVar} 14%, transparent)`,
        color: meta.accentVar,
      }}
    >
      try again
    </button>
  );
}

function shouldShowMissingActionHint({
  event,
  artifactProxyHref,
  artifactProxyDownloadHref,
  hasPreviewHandler,
}: {
  event: BuilderCompletionEventV1;
  artifactProxyHref: string | null;
  artifactProxyDownloadHref: string | null;
  hasPreviewHandler: boolean;
}): boolean {
  if (event.status !== 'success') {
    return false;
  }
  const downloadFirst = isDownloadFirstArtifact(event);
  const openHref = artifactProxyHref || event.artifact_url || null;
  const downloadHref = artifactProxyDownloadHref || event.artifact_url || null;
  return !(artifactProxyHref && !downloadFirst && hasPreviewHandler)
    && !(openHref && !downloadFirst)
    && !downloadHref;
}
