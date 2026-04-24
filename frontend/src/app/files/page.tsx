'use client';

import { ArrowLeft, Download, ExternalLink, FileText, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ProtectedRoute } from '../components/ProtectedRoute';
import { haptic } from '../hooks/useHaptics';
import { buildThreadArtifactHref, formatBuilderArtifactFileSize } from '../lib/builder-artifacts';
import { logger } from '../lib/error-logger';
import { useAuth } from '../providers';

interface BuilderFileItem {
  thread_id: string;
  session_id?: string | null;
  session_title?: string | null;
  path: string;
  name: string;
  size_bytes?: number | null;
  modified_at?: string | null;
  mime_type?: string | null;
}

interface BuilderFilesResponse {
  user_id: string;
  items: BuilderFileItem[];
  total: number;
  limit: number;
}

const DEFAULT_LIMIT = 30;

function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function groupByDate(items: BuilderFileItem[]): Array<{ label: string; items: BuilderFileItem[] }> {
  const today: BuilderFileItem[] = [];
  const week: BuilderFileItem[] = [];
  const month: BuilderFileItem[] = [];
  const older: BuilderFileItem[] = [];

  for (const item of items) {
    const ts = item.modified_at ? Date.parse(item.modified_at) : NaN;
    if (!Number.isFinite(ts)) {
      older.push(item);
      continue;
    }
    const days = Math.floor((Date.now() - ts) / 86_400_000);
    if (days <= 0) today.push(item);
    else if (days < 7) week.push(item);
    else if (days < 30) month.push(item);
    else older.push(item);
  }

  const groups = [
    { label: 'Today', items: today },
    { label: 'This week', items: week },
    { label: 'This month', items: month },
    { label: 'Earlier', items: older },
  ];
  return groups.filter((group) => group.items.length > 0);
}

export default function FilesPage() {
  return (
    <ProtectedRoute>
      <FilesPageContent />
    </ProtectedRoute>
  );
}

function FilesPageContent() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [items, setItems] = useState<BuilderFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/users/${encodeURIComponent(userId)}/builder-files?limit=${DEFAULT_LIMIT}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        throw new Error(`Failed to load files (${res.status})`);
      }
      const data = (await res.json()) as BuilderFilesResponse;
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      logger.error('files_page_load_failed', err);
      setError(err instanceof Error ? err.message : 'Unable to load files');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const handleDelete = useCallback(
    async (item: BuilderFileItem) => {
      const key = `${item.thread_id}:${item.path}`;
      setDeleting(key);
      const previousItems = items;
      setItems((current) => current.filter((candidate) => `${candidate.thread_id}:${candidate.path}` !== key));
      try {
        const encodedPath = item.path
          .split('/')
          .filter(Boolean)
          .map((segment) => encodeURIComponent(segment))
          .join('/');
        const res = await fetch(
          `/api/threads/${encodeURIComponent(item.thread_id)}/artifacts/${encodedPath}`,
          { method: 'DELETE' },
        );
        if (!res.ok && res.status !== 204 && res.status !== 404) {
          throw new Error(`Delete failed (${res.status})`);
        }
        haptic('medium');
      } catch (err) {
        logger.error('files_page_delete_failed', err);
        setItems(previousItems);
        setError(err instanceof Error ? err.message : 'Unable to delete file');
      } finally {
        setDeleting(null);
        setPendingDelete(null);
      }
    },
    [items],
  );

  const groups = useMemo(() => groupByDate(items), [items]);

  return (
    <div
      className="min-h-screen w-full px-4 pt-6 pb-24 sm:px-8"
      style={{ background: 'var(--cosmic-bg)' }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              href="/"
              className="mb-3 inline-flex items-center gap-1.5 text-[11px] tracking-[0.08em] uppercase transition-colors hover:opacity-80"
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </Link>
            <p
              className="text-[9px] tracking-[0.16em] uppercase"
              style={{ color: 'var(--cosmic-text-faint)' }}
            >
              Library
            </p>
            <h1
              className="font-cormorant mt-1 text-[28px] leading-[1.1] font-light sm:text-[34px]"
              style={{ color: 'var(--cosmic-text)' }}
            >
              Files
            </h1>
            <p
              className="mt-1 text-[12px]"
              style={{ color: 'var(--cosmic-text-whisper)' }}
            >
              Recent deliverables across your sessions. Up to {DEFAULT_LIMIT} most recent.
            </p>
          </div>
        </header>

        {loading ? (
          <div
            className="cosmic-surface-panel flex items-center justify-center gap-2 rounded-[20px] border py-16"
            style={{
              background: 'color-mix(in srgb, var(--cosmic-panel) 94%, transparent)',
              borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 92%, transparent)',
              color: 'var(--cosmic-text-faint)',
            }}
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-[12px]">Loading files…</span>
          </div>
        ) : error ? (
          <div
            className="cosmic-surface-panel rounded-[20px] border px-5 py-4 text-[12px]"
            style={{
              background: 'color-mix(in srgb, var(--cosmic-panel) 94%, transparent)',
              borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 92%, transparent)',
              color: 'var(--cosmic-text)',
            }}
          >
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void loadItems()}
              className="mt-2 text-[11px] underline"
              style={{ color: 'var(--sophia-purple)' }}
            >
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div
            className="cosmic-surface-panel rounded-[20px] border px-6 py-16 text-center"
            style={{
              background: 'color-mix(in srgb, var(--cosmic-panel) 94%, transparent)',
              borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 92%, transparent)',
            }}
          >
            <FileText
              className="mx-auto mb-3 h-6 w-6"
              style={{ color: 'var(--cosmic-text-faint)' }}
            />
            <p
              className="font-cormorant text-[18px] font-light"
              style={{ color: 'var(--cosmic-text)' }}
            >
              No files yet
            </p>
            <p
              className="mt-1 text-[12px]"
              style={{ color: 'var(--cosmic-text-whisper)' }}
            >
              Sophia&apos;s builder hasn&apos;t produced any deliverables yet.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <section key={group.label} className="flex flex-col gap-2">
                <h2
                  className="text-[9px] tracking-[0.16em] uppercase"
                  style={{ color: 'var(--cosmic-text-faint)' }}
                >
                  {group.label}
                </h2>
                <div
                  className="cosmic-surface-panel overflow-hidden rounded-[20px] border"
                  style={{
                    background: 'color-mix(in srgb, var(--cosmic-panel) 94%, transparent)',
                    borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 92%, transparent)',
                    boxShadow: 'var(--cosmic-shadow-md)',
                    backdropFilter: 'blur(20px) saturate(1.02)',
                    WebkitBackdropFilter: 'blur(20px) saturate(1.02)',
                  }}
                >
                  {group.items.map((item, index) => {
                    const key = `${item.thread_id}:${item.path}`;
                    const openHref = buildThreadArtifactHref(item.thread_id, item.path);
                    const downloadHref = buildThreadArtifactHref(item.thread_id, item.path, {
                      download: true,
                    });
                    const sizeLabel = formatBuilderArtifactFileSize(item.size_bytes ?? undefined);
                    const dateLabel = formatRelativeDate(item.modified_at);
                    const sessionLabel = item.session_title?.trim();
                    const meta = [sizeLabel, item.mime_type, sessionLabel, dateLabel]
                      .filter(Boolean)
                      .join(' • ');
                    const isPendingConfirm = pendingDelete === key;
                    const isDeleting = deleting === key;

                    return (
                      <div
                        key={key}
                        className="flex items-center gap-3 px-4 py-3 transition-colors"
                        style={{
                          borderTop:
                            index === 0
                              ? undefined
                              : '1px solid color-mix(in srgb, var(--cosmic-border-soft) 60%, transparent)',
                          background: isPendingConfirm
                            ? 'color-mix(in srgb, var(--sophia-purple) 6%, transparent)'
                            : undefined,
                        }}
                      >
                        <FileText
                          className="h-4 w-4 shrink-0"
                          style={{ color: 'var(--cosmic-text-faint)' }}
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate text-[13px]"
                            style={{ color: 'var(--cosmic-text-strong)' }}
                          >
                            {item.name}
                          </p>
                          {meta && (
                            <p
                              className="truncate text-[10px]"
                              style={{ color: 'var(--cosmic-text-faint)' }}
                            >
                              {meta}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {isPendingConfirm ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleDelete(item)}
                                disabled={isDeleting}
                                className="inline-flex h-7 items-center gap-1 rounded-full border px-3 text-[10px] lowercase tracking-[0.04em] transition-colors"
                                style={{
                                  borderColor:
                                    'color-mix(in srgb, #ff6b6b 30%, var(--cosmic-border-soft))',
                                  color: '#ff6b6b',
                                  background: 'color-mix(in srgb, #ff6b6b 6%, transparent)',
                                }}
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                                confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(null)}
                                disabled={isDeleting}
                                className="inline-flex h-7 items-center rounded-full border px-3 text-[10px] lowercase tracking-[0.04em]"
                                style={{
                                  borderColor:
                                    'color-mix(in srgb, var(--cosmic-border-soft) 82%, transparent)',
                                  color: 'var(--cosmic-text-whisper)',
                                }}
                              >
                                cancel
                              </button>
                            </>
                          ) : (
                            <>
                              {openHref && (
                                <a
                                  href={openHref}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Open ${item.name}`}
                                  className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[10px] lowercase tracking-[0.04em] transition-colors"
                                  style={{
                                    borderColor:
                                      'color-mix(in srgb, var(--cosmic-border-soft) 82%, transparent)',
                                    color: 'var(--cosmic-text-whisper)',
                                    background:
                                      'color-mix(in srgb, var(--cosmic-panel-soft) 10%, transparent)',
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
                                    borderColor:
                                      'color-mix(in srgb, var(--sophia-purple) 18%, var(--cosmic-border-soft))',
                                    color: 'var(--sophia-purple)',
                                    background:
                                      'color-mix(in srgb, var(--sophia-purple) 4%, transparent)',
                                  }}
                                  onClick={() => haptic('medium')}
                                >
                                  <Download className="h-3 w-3" />
                                  download
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  haptic('light');
                                  setPendingDelete(key);
                                }}
                                aria-label={`Delete ${item.name}`}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors"
                                style={{
                                  borderColor:
                                    'color-mix(in srgb, var(--cosmic-border-soft) 82%, transparent)',
                                  color: 'var(--cosmic-text-whisper)',
                                }}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
