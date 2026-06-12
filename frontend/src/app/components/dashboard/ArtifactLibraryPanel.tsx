'use client';

import {
  Download,
  ExternalLink,
  FileText,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { saveArtifactLibraryOpenHandoff } from '../../lib/artifact-library-open-handoff';
import {
  buildArtifactRegistryContentHref,
  buildArtifactRegistryDownloadHref,
  dedupeVisibleArtifactRegistryRecords,
  deleteArtifactRegistryRecord,
  fetchArtifactRegistryTextPreview,
  fetchArtifactRegistryList,
  openArtifactRegistryRecord,
  type ArtifactRegistryListFilters,
  type ArtifactRegistryRecord,
} from '../../lib/artifact-registry';
import { cn } from '../../lib/utils';
import { useSessionStore } from '../../stores/session-store';
import { ArtifactMarkdownPreview } from '../session/ArtifactMarkdownPreview';

type ArtifactTypeFilter = 'all' | 'html' | 'pdf' | 'markdown' | 'pptx' | 'image';
type ArtifactSourceFilter = 'all' | 'builder' | 'upload' | 'quick_edit' | 'coreview_version' | 'file_library_backfill';
type ArtifactDateFilter = 'updated' | 'created' | 'recent';

const TYPE_OPTIONS: Array<{ value: ArtifactTypeFilter; label: string }> = [
  { value: 'all', label: 'All types' },
  { value: 'html', label: 'HTML' },
  { value: 'pdf', label: 'PDF' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'pptx', label: 'PPTX' },
  { value: 'image', label: 'Image' },
];

const SOURCE_OPTIONS: Array<{ value: ArtifactSourceFilter; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'builder', label: 'Builder' },
  { value: 'upload', label: 'Upload' },
  { value: 'quick_edit', label: 'Quick edit' },
  { value: 'coreview_version', label: 'Coreview' },
  { value: 'file_library_backfill', label: 'Backfill' },
];

const DATE_OPTIONS: Array<{ value: ArtifactDateFilter; label: string }> = [
  { value: 'updated', label: 'Updated' },
  { value: 'created', label: 'Created' },
  { value: 'recent', label: 'Opened' },
];

export function ArtifactLibraryPanel() {
  const router = useRouter();
  const currentSession = useSessionStore((state) => state.session);
  const createSession = useSessionStore((state) => state.createSession);
  const updateFromBackend = useSessionStore((state) => state.updateFromBackend);
  const [artifacts, setArtifacts] = useState<ArtifactRegistryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState<ArtifactTypeFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<ArtifactSourceFilter>('all');
  const [dateFilter, setDateFilter] = useState<ArtifactDateFilter>('updated');
  const [threadFilter, setThreadFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [openingArtifactId, setOpeningArtifactId] = useState<string | null>(null);
  const [sessionOpeningArtifactId, setSessionOpeningArtifactId] = useState<string | null>(null);
  const [deletingArtifactId, setDeletingArtifactId] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRegistryRecord | null>(null);
  const [previewLoadingArtifactId, setPreviewLoadingArtifactId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const filters = useMemo<ArtifactRegistryListFilters>(() => ({
    artifactType: typeFilter,
    source: sourceFilter,
    threadId: threadFilter,
    search,
    sort: dateFilter,
  }), [dateFilter, search, sourceFilter, threadFilter, typeFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchArtifactRegistryList(filters)
      .then((response) => {
        if (cancelled) return;
        const visibleArtifacts = dedupeVisibleArtifactRegistryRecords(response.artifacts);
        setArtifacts(visibleArtifacts);
        setTotal(visibleArtifacts.length);
        setSelectedArtifact((current) => {
          if (!current) return null;
          return visibleArtifacts.find((artifact) => artifact.artifact_id === current.artifact_id) ?? null;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setArtifacts([]);
        setTotal(0);
        setError('Unable to load artifacts');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filters, refreshNonce]);

  const handleOpenInline = useCallback(async (artifact: ArtifactRegistryRecord) => {
    setOpeningArtifactId(artifact.artifact_id);
    setError(null);
    setPreviewError(null);
    setPreviewText(null);
    try {
      const response = await openArtifactRegistryRecord(artifact.artifact_id);
      const openedArtifact = response.artifact;
      setSelectedArtifact(openedArtifact);
      setArtifacts((current) => current.map((item) => (
        item.artifact_id === openedArtifact.artifact_id ? openedArtifact : item
      )));
      if (shouldLoadTextPreview(openedArtifact)) {
        setPreviewLoadingArtifactId(openedArtifact.artifact_id);
        try {
          setPreviewText(await fetchArtifactRegistryTextPreview(openedArtifact.artifact_id));
        } catch {
          setPreviewError('Unable to load preview');
        } finally {
          setPreviewLoadingArtifactId((current) => (
            current === openedArtifact.artifact_id ? null : current
          ));
        }
      }
    } catch {
      setError('Unable to open artifact');
      setSelectedArtifact(null);
    } finally {
      setOpeningArtifactId(null);
    }
  }, []);

  const handleOpenInSessionCanvas = useCallback(async (artifact: ArtifactRegistryRecord) => {
    setSessionOpeningArtifactId(artifact.artifact_id);
    setError(null);
    try {
      const response = await openArtifactRegistryRecord(artifact.artifact_id);
      if (!saveArtifactLibraryOpenHandoff(response)) {
        throw new Error('artifact_library_handoff_save_failed');
      }
      const target = response.canvas_target;
      const targetSessionId = target.session_id ?? response.artifact.session_id ?? target.thread_id;
      if (target.thread_id && targetSessionId) {
        if (!currentSession) {
          createSession(response.artifact.user_id || 'anonymous', 'open', 'life');
        }
        updateFromBackend(targetSessionId, target.thread_id);
      }
      router.push('/session');
    } catch {
      setError('Unable to open artifact');
    } finally {
      setSessionOpeningArtifactId(null);
    }
  }, [createSession, currentSession, router, updateFromBackend]);

  const handleDeleteArtifact = useCallback(async (artifact: ArtifactRegistryRecord) => {
    const label = artifact.title || artifact.filename;
    if (!window.confirm(`Hide "${label}" from the artifact dashboard?`)) {
      return;
    }
    setDeletingArtifactId(artifact.artifact_id);
    setError(null);
    try {
      await deleteArtifactRegistryRecord(artifact.artifact_id);
      setArtifacts((current) => current.filter((item) => item.artifact_id !== artifact.artifact_id));
      setTotal((current) => Math.max(0, current - 1));
      setSelectedArtifact((current) => (
        current?.artifact_id === artifact.artifact_id ? null : current
      ));
      if (previewLoadingArtifactId === artifact.artifact_id) {
        setPreviewLoadingArtifactId(null);
      }
      setPreviewText(null);
      setPreviewError(null);
    } catch {
      setError('Unable to delete artifact');
    } finally {
      setDeletingArtifactId(null);
    }
  }, [previewLoadingArtifactId]);

  return (
    <section
      aria-labelledby="artifact-library-title"
      className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 pb-28 pt-8 sm:px-8 lg:pl-20 lg:pr-8"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
              Dashboard
            </p>
            <h1
              id="artifact-library-title"
              className="mt-1 font-cormorant text-[2.2rem] font-light leading-tight sm:text-[3rem]"
              style={{ color: 'var(--cosmic-text-strong)' }}
            >
              Artifacts
            </h1>
          </div>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
            <span data-testid="artifact-library-count">{total} total</span>
            <button
              type="button"
              aria-label="Refresh artifacts"
              onClick={() => setRefreshNonce((value) => value + 1)}
              className="cosmic-focus-ring flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/[0.06]"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          className="cosmic-surface-panel grid gap-3 rounded-[14px] p-3 sm:grid-cols-[minmax(180px,1fr)_repeat(3,minmax(140px,auto))] lg:grid-cols-[minmax(220px,1fr)_160px_170px_160px_180px]"
          data-testid="artifact-library-filters"
        >
          <label className="relative block">
            <span className="sr-only">Search artifacts</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--cosmic-text-whisper)' }} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              className="cosmic-focus-ring h-10 w-full rounded-[10px] border bg-transparent pl-9 pr-3 text-[13px] outline-none"
              style={{
                borderColor: 'var(--cosmic-border-soft)',
                color: 'var(--cosmic-text)',
              }}
            />
          </label>

          <FilterSelect
            label="Type"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as ArtifactTypeFilter)}
            options={TYPE_OPTIONS}
          />
          <FilterSelect
            label="Source"
            value={sourceFilter}
            onChange={(value) => setSourceFilter(value as ArtifactSourceFilter)}
            options={SOURCE_OPTIONS}
          />
          <FilterSelect
            label="Date"
            value={dateFilter}
            onChange={(value) => setDateFilter(value as ArtifactDateFilter)}
            options={DATE_OPTIONS}
          />
          <label className="block">
            <span className="sr-only">Session or thread</span>
            <input
              value={threadFilter}
              onChange={(event) => setThreadFilter(event.target.value)}
              placeholder="Thread"
              className="cosmic-focus-ring h-10 w-full rounded-[10px] border bg-transparent px-3 text-[13px] outline-none"
              style={{
                borderColor: 'var(--cosmic-border-soft)',
                color: 'var(--cosmic-text)',
              }}
            />
          </label>
        </div>

        {error && (
          <div
            className="rounded-[12px] border px-4 py-3 text-[13px]"
            style={{
              borderColor: 'var(--cosmic-danger-border)',
              background: 'var(--cosmic-danger-bg)',
              color: 'var(--cosmic-danger-text)',
            }}
          >
            {error}
          </div>
        )}

        <div
          className={cn(
            'grid min-h-[360px] gap-4',
            selectedArtifact && !loading ? 'xl:grid-cols-[minmax(0,1fr)_430px]' : '',
          )}
          data-testid="artifact-library-panel"
        >
          <div>
            {loading ? (
              <ArtifactLibraryLoading />
            ) : artifacts.length === 0 ? (
              <ArtifactLibraryEmptyState />
            ) : (
              <div className="flex flex-col gap-2" data-testid="artifact-library-list">
                {artifacts.map((artifact) => (
                  <ArtifactLibraryRow
                    key={artifact.artifact_id}
                    artifact={artifact}
                    selected={selectedArtifact?.artifact_id === artifact.artifact_id}
                    opening={openingArtifactId === artifact.artifact_id}
                    sessionOpening={sessionOpeningArtifactId === artifact.artifact_id}
                    deleting={deletingArtifactId === artifact.artifact_id}
                    onOpenInline={() => handleOpenInline(artifact)}
                    onOpenInSession={() => handleOpenInSessionCanvas(artifact)}
                    onDelete={() => handleDeleteArtifact(artifact)}
                  />
                ))}
              </div>
            )}
          </div>

          {selectedArtifact && !loading && (
            <ArtifactLibraryDetailPanel
              artifact={selectedArtifact}
              previewText={previewText}
              previewLoading={previewLoadingArtifactId === selectedArtifact.artifact_id}
              previewError={previewError}
              sessionOpening={sessionOpeningArtifactId === selectedArtifact.artifact_id}
              deleting={deletingArtifactId === selectedArtifact.artifact_id}
              onClose={() => {
                setSelectedArtifact(null);
                setPreviewText(null);
                setPreviewError(null);
              }}
              onOpenInSession={() => handleOpenInSessionCanvas(selectedArtifact)}
              onDelete={() => handleDeleteArtifact(selectedArtifact)}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="cosmic-focus-ring h-10 w-full rounded-[10px] border bg-transparent px-3 text-[13px] outline-none"
        style={{
          borderColor: 'var(--cosmic-border-soft)',
          color: 'var(--cosmic-text)',
        }}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ArtifactLibraryRow({
  artifact,
  selected,
  opening,
  sessionOpening,
  deleting,
  onOpenInline,
  onOpenInSession,
  onDelete,
}: {
  artifact: ArtifactRegistryRecord;
  selected: boolean;
  opening: boolean;
  sessionOpening: boolean;
  deleting: boolean;
  onOpenInline: () => void;
  onOpenInSession: () => void;
  onDelete: () => void;
}) {
  const openHref = buildArtifactRegistryContentHref(artifact.artifact_id);
  const downloadHref = buildArtifactRegistryDownloadHref(artifact.artifact_id);
  const label = artifact.title || artifact.filename;

  return (
    <article
      className={cn(
        'group grid gap-3 rounded-[14px] border px-4 py-3 transition-all duration-200',
        'sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center',
      )}
      style={{
        borderColor: selected ? 'var(--sophia-purple)' : 'var(--cosmic-border-soft)',
        background: 'color-mix(in srgb, var(--cosmic-panel) 74%, transparent)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.10)',
      }}
      data-testid="artifact-library-row"
      data-selected={selected ? 'true' : 'false'}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0" style={{ color: 'var(--sophia-purple)' }} />
          <h2 className="truncate text-[15px] font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
            {artifact.title || artifact.filename}
          </h2>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--cosmic-text-muted)' }}>
          <Badge>{formatArtifactType(artifact.artifact_type)}</Badge>
          <Badge>{formatSource(artifact.source)}</Badge>
          <span>{artifact.filename}</span>
          <span>{formatDate(artifact.created_at)}</span>
          {artifact.last_opened_at && <span>Opened {formatDate(artifact.last_opened_at)}</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <button
          type="button"
          onClick={onOpenInline}
          disabled={opening || sessionOpening || deleting}
          className="cosmic-focus-ring inline-flex h-9 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-all hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-60"
          aria-label={`Open ${label} inline`}
          style={{ color: 'var(--cosmic-text)' }}
        >
          {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <PanelRightOpen className="h-4 w-4" />}
          Open
        </button>
        <button
          type="button"
          onClick={onOpenInSession}
          disabled={opening || sessionOpening || deleting}
          className="cosmic-focus-ring inline-flex h-9 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-all hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-60"
          aria-label={`Open ${label} in Session Canvas`}
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          {sessionOpening ? <Loader2 className="h-4 w-4 animate-spin" /> : <PanelRightOpen className="h-4 w-4" />}
          Session
        </button>
        <a
          href={openHref}
          target="_blank"
          rel="noreferrer"
          className="cosmic-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full transition-all hover:bg-white/[0.06]"
          aria-label={`Open ${label} preview in new tab`}
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <a
          href={downloadHref}
          className="cosmic-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full transition-all hover:bg-white/[0.06]"
          aria-label={`Download ${label}`}
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          <Download className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting || opening || sessionOpening}
          className="cosmic-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full transition-all hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-60"
          aria-label={`Delete ${label}`}
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>
    </article>
  );
}

function ArtifactLibraryDetailPanel({
  artifact,
  previewText,
  previewLoading,
  previewError,
  sessionOpening,
  deleting,
  onClose,
  onOpenInSession,
  onDelete,
}: {
  artifact: ArtifactRegistryRecord;
  previewText: string | null;
  previewLoading: boolean;
  previewError: string | null;
  sessionOpening: boolean;
  deleting: boolean;
  onClose: () => void;
  onOpenInSession: () => void;
  onDelete: () => void;
}) {
  const label = artifact.title || artifact.filename;
  const contentHref = buildArtifactRegistryContentHref(artifact.artifact_id);
  const downloadHref = buildArtifactRegistryDownloadHref(artifact.artifact_id);

  return (
    <aside
      className="cosmic-surface-panel sticky top-6 flex max-h-[calc(100vh-3rem)] min-h-[520px] flex-col overflow-hidden rounded-[14px] border"
      style={{
        borderColor: 'var(--cosmic-border-soft)',
        background: 'color-mix(in srgb, var(--cosmic-panel) 88%, transparent)',
      }}
      data-testid="artifact-library-detail"
      aria-label={`${label} artifact viewer`}
    >
      <div className="flex items-start justify-between gap-3 border-b p-4" style={{ borderColor: 'var(--cosmic-border-soft)' }}>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase" style={{ color: 'var(--cosmic-text-whisper)' }}>
            Artifact
          </p>
          <h2 className="mt-1 truncate text-[17px] font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
            {label}
          </h2>
          <p className="mt-1 truncate text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
            {artifact.filename}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cosmic-focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all hover:bg-white/[0.06]"
          aria-label="Close artifact viewer"
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-3 border-b p-4 text-[12px]" style={{ borderColor: 'var(--cosmic-border-soft)' }}>
        <MetadataItem label="Type" value={formatArtifactType(artifact.artifact_type)} />
        <MetadataItem label="Source" value={formatSource(artifact.source)} />
        <MetadataItem label="Created" value={formatDate(artifact.created_at)} />
        <MetadataItem label="Storage" value={formatStorageStatus(artifact.storage_status)} />
      </dl>

      <div className="flex min-h-0 flex-1 flex-col">
        <ArtifactLibraryPreview
          artifact={artifact}
          contentHref={contentHref}
          previewText={previewText}
          previewLoading={previewLoading}
          previewError={previewError}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t p-4" style={{ borderColor: 'var(--cosmic-border-soft)' }}>
        <a
          href={downloadHref}
          className="cosmic-focus-ring inline-flex h-9 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-all hover:bg-white/[0.06]"
          aria-label={`Download ${label}`}
          style={{ color: 'var(--cosmic-text)' }}
        >
          <Download className="h-4 w-4" />
          Download
        </a>
        <a
          href={contentHref}
          target="_blank"
          rel="noreferrer"
          className="cosmic-focus-ring inline-flex h-9 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-all hover:bg-white/[0.06]"
          aria-label={`Open ${label} preview in new tab`}
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          <ExternalLink className="h-4 w-4" />
          Open tab
        </a>
        <button
          type="button"
          onClick={onOpenInSession}
          disabled={sessionOpening || deleting}
          className="cosmic-focus-ring inline-flex h-9 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-all hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-60"
          aria-label={`Open ${label} in Session Canvas`}
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          {sessionOpening ? <Loader2 className="h-4 w-4 animate-spin" /> : <PanelRightOpen className="h-4 w-4" />}
          Session Canvas
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting || sessionOpening}
          className="cosmic-focus-ring ml-auto inline-flex h-9 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-all hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-60"
          aria-label={`Delete ${label}`}
          style={{ color: 'var(--cosmic-text-muted)' }}
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Delete
        </button>
      </div>
    </aside>
  );
}

function ArtifactLibraryPreview({
  artifact,
  contentHref,
  previewText,
  previewLoading,
  previewError,
}: {
  artifact: ArtifactRegistryRecord;
  contentHref: string;
  previewText: string | null;
  previewLoading: boolean;
  previewError: string | null;
}) {
  const label = artifact.title || artifact.filename;
  if (shouldLoadTextPreview(artifact)) {
    if (previewLoading) {
      return (
        <div className="flex flex-1 items-center justify-center" data-testid="artifact-library-preview-loading">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--sophia-purple)' }} />
        </div>
      );
    }
    if (previewError) {
      return <PreviewUnavailable message={previewError} />;
    }
    if (previewText !== null) {
      return (
        <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="artifact-library-markdown-preview">
          <ArtifactMarkdownPreview markdown={previewText} />
        </div>
      );
    }
    return <PreviewUnavailable message="Preview unavailable" />;
  }

  if (isHtmlArtifact(artifact)) {
    return (
      <iframe
        src={contentHref}
        title={`${label} preview`}
        sandbox=""
        className="min-h-[440px] w-full flex-1 border-0 bg-white"
        data-testid="artifact-library-html-preview"
      />
    );
  }

  if (isPdfArtifact(artifact)) {
    return (
      <iframe
        src={contentHref}
        title={`${label} PDF preview`}
        className="min-h-[440px] w-full flex-1 border-0 bg-white"
        data-testid="artifact-library-pdf-preview"
      />
    );
  }

  if (isImageArtifact(artifact)) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={contentHref}
          alt={label}
          className="max-h-full max-w-full rounded-[10px] object-contain"
          data-testid="artifact-library-image-preview"
        />
      </div>
    );
  }

  return <PreviewUnavailable message="Native preview unavailable" />;
}

function PreviewUnavailable({ message }: { message: string }) {
  return (
    <div
      className="flex flex-1 items-center justify-center px-6 text-center text-[13px]"
      style={{ color: 'var(--cosmic-text-muted)' }}
      data-testid="artifact-library-preview-unavailable"
    >
      {message}
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase" style={{ color: 'var(--cosmic-text-whisper)' }}>
        {label}
      </dt>
      <dd className="mt-1 truncate" style={{ color: 'var(--cosmic-text)' }}>
        {value}
      </dd>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-full border px-2 py-0.5"
      style={{
        borderColor: 'var(--cosmic-border-soft)',
        color: 'var(--cosmic-text)',
      }}
    >
      {children}
    </span>
  );
}

function ArtifactLibraryLoading() {
  return (
    <div className="flex min-h-[320px] items-center justify-center" data-testid="artifact-library-loading">
      <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--sophia-purple)' }} />
    </div>
  );
}

function ArtifactLibraryEmptyState() {
  return (
    <div
      className="flex min-h-[320px] flex-col items-center justify-center rounded-[16px] border px-6 text-center"
      style={{
        borderColor: 'var(--cosmic-border-soft)',
        background: 'color-mix(in srgb, var(--cosmic-panel) 62%, transparent)',
      }}
      data-testid="artifact-library-empty"
    >
      <FileText className="h-8 w-8" style={{ color: 'var(--cosmic-text-whisper)' }} />
      <p className="mt-3 text-[15px] font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
        No artifacts yet
      </p>
    </div>
  );
}

function formatArtifactType(value: string): string {
  if (value === 'html') return 'HTML';
  if (value === 'pdf') return 'PDF';
  if (value === 'pptx') return 'PPTX';
  if (value === 'markdown') return 'Markdown';
  if (value === 'image') return 'Image';
  return 'Other';
}

function formatSource(value: ArtifactRegistryRecord['source']): string {
  if (value === 'quick_edit') return 'Quick edit';
  if (value === 'coreview_version') return 'Coreview';
  if (value === 'file_library_backfill' || value === 'backfill') return 'Backfill';
  if (value === 'builder') return 'Builder';
  return 'Upload';
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown';
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return 'Unknown';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(timestamp));
}

function formatStorageStatus(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'Unknown';
  if (normalized === 'available') return 'Available';
  if (normalized === 'missing') return 'Missing';
  if (normalized === 'supabase') return 'Supabase';
  return normalized.replace(/_/gu, ' ');
}

function shouldLoadTextPreview(artifact: ArtifactRegistryRecord): boolean {
  const rendererKind = String(artifact.renderer_kind || '').toLowerCase();
  const artifactType = artifact.artifact_type.toLowerCase();
  const mimeType = artifact.mime_type?.split(';')[0]?.toLowerCase() ?? '';
  const filename = artifact.filename.toLowerCase();
  return (
    rendererKind === 'markdown'
    || artifactType === 'markdown'
    || mimeType === 'text/markdown'
    || mimeType === 'text/x-markdown'
    || filename.endsWith('.md')
    || filename.endsWith('.markdown')
  );
}

function isHtmlArtifact(artifact: ArtifactRegistryRecord): boolean {
  const rendererKind = String(artifact.renderer_kind || '').toLowerCase();
  const artifactType = artifact.artifact_type.toLowerCase();
  const mimeType = artifact.mime_type?.split(';')[0]?.toLowerCase() ?? '';
  const filename = artifact.filename.toLowerCase();
  return (
    rendererKind === 'html'
    || artifactType === 'html'
    || artifactType === 'webpage'
    || mimeType === 'text/html'
    || filename.endsWith('.html')
    || filename.endsWith('.htm')
  );
}

function isPdfArtifact(artifact: ArtifactRegistryRecord): boolean {
  const rendererKind = String(artifact.renderer_kind || '').toLowerCase();
  const artifactType = artifact.artifact_type.toLowerCase();
  const mimeType = artifact.mime_type?.split(';')[0]?.toLowerCase() ?? '';
  const filename = artifact.filename.toLowerCase();
  return (
    rendererKind === 'pdf'
    || artifactType === 'pdf'
    || mimeType === 'application/pdf'
    || filename.endsWith('.pdf')
  );
}

function isImageArtifact(artifact: ArtifactRegistryRecord): boolean {
  const rendererKind = String(artifact.renderer_kind || '').toLowerCase();
  const artifactType = artifact.artifact_type.toLowerCase();
  const mimeType = artifact.mime_type?.split(';')[0]?.toLowerCase() ?? '';
  return rendererKind === 'image' || artifactType === 'image' || mimeType.startsWith('image/');
}
