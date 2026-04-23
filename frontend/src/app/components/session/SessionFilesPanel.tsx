'use client';

import { Download, ExternalLink, FileText, X } from 'lucide-react';

import { haptic } from '../../hooks/useHaptics';
import { buildThreadArtifactHref, formatBuilderArtifactFileSize } from '../../lib/builder-artifacts';
import { cn } from '../../lib/utils';
import type { BuilderArtifactLibraryItemV1 } from '../../types/builder-artifact';

interface SessionFilesPanelProps {
  items: BuilderArtifactLibraryItemV1[];
  threadId?: string;
  isVisible: boolean;
  onDismiss: () => void;
  className?: string;
}

export function SessionFilesPanel({
  items,
  threadId,
  isVisible,
  onDismiss,
  className,
}: SessionFilesPanelProps) {
  if (!isVisible || items.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'cosmic-surface-panel relative overflow-hidden rounded-[20px] border',
        className,
      )}
      style={{
        background: 'color-mix(in srgb, var(--cosmic-panel) 94%, transparent)',
        borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 92%, transparent)',
        boxShadow: 'var(--cosmic-shadow-md)',
        backdropFilter: 'blur(20px) saturate(1.02)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.02)',
      }}
      role="dialog"
      aria-label="Session files"
    >
      <div className="px-4 py-3.5 sm:px-4 sm:py-4">
        <div className="mb-2.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[9px] tracking-[0.16em] uppercase" style={{ color: 'var(--cosmic-text-faint)' }}>
                Session Files
              </p>
              <span
                className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px]"
                style={{
                  background: 'color-mix(in srgb, var(--cosmic-panel-soft) 70%, transparent)',
                  color: 'var(--cosmic-text-whisper)',
                  border: '1px solid color-mix(in srgb, var(--cosmic-border-soft) 88%, transparent)',
                }}
              >
                {items.length}
              </span>
            </div>
            <p className="mt-1 font-cormorant text-[15px] leading-[1.15] font-light sm:text-[16px]" style={{ color: 'var(--cosmic-text)' }}>
              Saved outputs for this session
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Close session files"
              className="cosmic-whisper-button inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors"
              style={{
                color: 'var(--cosmic-text-whisper)',
                background: 'color-mix(in srgb, var(--cosmic-panel-soft) 18%, transparent)',
              }}
              onClick={() => {
                haptic('light');
                onDismiss();
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="max-h-[min(56vh,380px)] space-y-1.5 overflow-y-auto pr-0.5">
          {items.map((item) => {
            const openHref = buildThreadArtifactHref(threadId, item.path);
            const downloadHref = buildThreadArtifactHref(threadId, item.path, { download: true });
            const meta = [formatBuilderArtifactFileSize(item.sizeBytes), item.mimeType]
              .filter(Boolean)
              .join(' • ');

            return (
              <div
                key={item.path}
                className="flex items-center gap-2.5 rounded-[16px] border px-3 py-2"
                style={{
                  borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 76%, transparent)',
                  background: 'color-mix(in srgb, var(--cosmic-panel-soft) 22%, transparent)',
                }}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cosmic-text-faint)' }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] tracking-[0.01em]" style={{ color: 'var(--cosmic-text-strong)' }}>
                    {item.name}
                  </p>
                  {meta && (
                    <p className="text-[9px]" style={{ color: 'var(--cosmic-text-faint)' }}>
                      {meta}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {openHref && (
                    <a
                      href={openHref}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${item.name}`}
                      className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[10px] lowercase tracking-[0.04em] transition-colors"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 82%, transparent)',
                        color: 'var(--cosmic-text-whisper)',
                        background: 'color-mix(in srgb, var(--cosmic-panel-soft) 10%, transparent)',
                      }}
                      onClick={() => haptic('light')}
                    >
                      <ExternalLink className="h-3 w-3" />
                      open
                    </a>
                  )}
                  {downloadHref && (
                    <a
                      href={downloadHref}
                      aria-label={`Download ${item.name}`}
                      className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[10px] lowercase tracking-[0.04em] transition-colors"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--sophia-purple) 18%, var(--cosmic-border-soft))',
                        color: 'var(--sophia-purple)',
                        background: 'color-mix(in srgb, var(--sophia-purple) 4%, transparent)',
                      }}
                      onClick={() => haptic('medium')}
                    >
                      <Download className="h-3 w-3" />
                      download
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {!threadId ? (
          <p className="mt-2.5 text-[10px] italic" style={{ color: 'var(--cosmic-text-faint)' }}>
            Files will appear once the thread sync completes.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default SessionFilesPanel;