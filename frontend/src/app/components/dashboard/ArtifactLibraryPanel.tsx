'use client';

import {
  Download,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

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
import { ArtifactMarkdownPreview } from '../session/ArtifactMarkdownPreview';

import {
  createArtifactObservatoryRenderer,
  type ArtifactObservatoryRenderer,
} from './artifact-observatory-renderer';

import styles from './ArtifactObservatory.module.css';

type ArtifactTypeFilter = 'all' | 'html' | 'pdf' | 'markdown' | 'pptx' | 'image';
type ArtifactSourceFilter = 'all' | 'builder' | 'upload' | 'quick_edit' | 'coreview_version' | 'file_library_backfill';
type ArtifactDateFilter = 'updated' | 'created' | 'recent';
type ObservatoryFilter = 'all' | 'builder' | 'recent' | 'document' | 'visual';
type ObservatoryFamily = 'document' | 'visual' | 'deck' | 'other';

type ObservatoryArtifact = ArtifactRegistryRecord & {
  accent: string;
  glow: string;
  x: number;
  y: number;
  family: ObservatoryFamily;
  kindLabel: string;
  sourceLabel: string;
  dateLabel: string;
  shortDateLabel: string;
  storageLabel: string;
  summary: string;
};

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

const OBSERVATORY_FILTERS: Array<{ value: ObservatoryFilter; label: string }> = [
  { value: 'all', label: 'Deep field' },
  { value: 'builder', label: 'Sophia-made' },
  { value: 'recent', label: 'Recent light' },
  { value: 'document', label: 'Documents' },
  { value: 'visual', label: 'Visual bodies' },
];

const FIELD_POSITIONS = [
  { x: 0.36, y: 0.32 },
  { x: 0.60, y: 0.24 },
  { x: 0.75, y: 0.43 },
  { x: 0.49, y: 0.58 },
  { x: 0.23, y: 0.58 },
  { x: 0.66, y: 0.65 },
  { x: 0.16, y: 0.39 },
  { x: 0.83, y: 0.30 },
  { x: 0.40, y: 0.18 },
];

const ACCENTS = [
  { accent: '#b8a4e8', glow: 'rgba(184,164,232,0.86)' },
  { accent: '#61c8bb', glow: 'rgba(97,200,187,0.86)' },
  { accent: '#d7b070', glow: 'rgba(215,176,112,0.86)' },
  { accent: '#8db7e4', glow: 'rgba(141,183,228,0.86)' },
  { accent: '#d48cab', glow: 'rgba(212,140,171,0.86)' },
  { accent: '#9ed7c7', glow: 'rgba(158,215,199,0.86)' },
  { accent: '#a6a0d8', glow: 'rgba(166,160,216,0.86)' },
  { accent: '#e1b7cc', glow: 'rgba(225,183,204,0.86)' },
  { accent: '#f0c987', glow: 'rgba(240,201,135,0.86)' },
];

export function ArtifactLibraryPanel() {
  const [artifacts, setArtifacts] = useState<ArtifactRegistryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState<ArtifactTypeFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<ArtifactSourceFilter>('all');
  const [dateFilter, setDateFilter] = useState<ArtifactDateFilter>('updated');
  const [threadFilter, setThreadFilter] = useState('');
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<ObservatoryFilter>('all');
  const [atlasMode, setAtlasMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [openingArtifactId, setOpeningArtifactId] = useState<string | null>(null);
  const [deletingArtifactId, setDeletingArtifactId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [openedArtifactId, setOpenedArtifactId] = useState<string | null>(null);
  const [previewLoadingArtifactId, setPreviewLoadingArtifactId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filters = useMemo<ArtifactRegistryListFilters>(() => ({
    artifactType: typeFilter,
    source: sourceFilter,
    threadId: threadFilter,
    search,
    sort: dateFilter,
  }), [dateFilter, search, sourceFilter, threadFilter, typeFilter]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToastMessage('');
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
  }, []);

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
        setSelectedArtifactId((current) => {
          if (current && visibleArtifacts.some((artifact) => artifact.artifact_id === current)) {
            return current;
          }
          return visibleArtifacts[0]?.artifact_id ?? null;
        });
        setOpenedArtifactId((current) => (
          current && visibleArtifacts.some((artifact) => artifact.artifact_id === current) ? current : null
        ));
      })
      .catch(() => {
        if (cancelled) return;
        setArtifacts([]);
        setTotal(0);
        setSelectedArtifactId(null);
        setOpenedArtifactId(null);
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

  const observatoryArtifacts = useMemo(
    () => artifacts.map((artifact, index) => toObservatoryArtifact(artifact, index)),
    [artifacts],
  );

  const visibleArtifacts = useMemo(
    () => observatoryArtifacts.filter((artifact) => matchesObservatoryFilter(artifact, activeFilter)),
    [activeFilter, observatoryArtifacts],
  );

  const selectedArtifact = useMemo(() => {
    if (!visibleArtifacts.length) return null;
    return (
      visibleArtifacts.find((artifact) => artifact.artifact_id === selectedArtifactId)
      ?? visibleArtifacts[0]
    );
  }, [selectedArtifactId, visibleArtifacts]);

  useEffect(() => {
    if (!visibleArtifacts.length) {
      setSelectedArtifactId(null);
      return;
    }
    setSelectedArtifactId((current) => (
      current && visibleArtifacts.some((artifact) => artifact.artifact_id === current)
        ? current
        : visibleArtifacts[0].artifact_id
    ));
  }, [visibleArtifacts]);

  const handleSelectArtifact = useCallback((artifact: ObservatoryArtifact) => {
    setSelectedArtifactId(artifact.artifact_id);
    if (openedArtifactId !== artifact.artifact_id) {
      setPreviewText(null);
      setPreviewError(null);
      setPreviewLoadingArtifactId(null);
    }
  }, [openedArtifactId]);

  const handleOpenInline = useCallback(async (artifact: ObservatoryArtifact) => {
    setOpeningArtifactId(artifact.artifact_id);
    setSelectedArtifactId(artifact.artifact_id);
    setError(null);
    setPreviewError(null);
    setPreviewText(null);
    try {
      const response = await openArtifactRegistryRecord(artifact.artifact_id);
      const openedArtifact = response.artifact;
      setOpenedArtifactId(openedArtifact.artifact_id);
      setSelectedArtifactId(openedArtifact.artifact_id);
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
      showToast(`${openedArtifact.title || openedArtifact.filename} is in the lens`);
    } catch {
      setError('Unable to open artifact');
      setPreviewError('Unable to open artifact');
      setOpenedArtifactId(null);
      showToast('Unable to open artifact');
    } finally {
      setOpeningArtifactId(null);
    }
  }, [showToast]);

  const handleDeleteArtifact = useCallback(async (artifact: ObservatoryArtifact) => {
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
      setSelectedArtifactId((current) => (
        current === artifact.artifact_id ? null : current
      ));
      setOpenedArtifactId((current) => (
        current === artifact.artifact_id ? null : current
      ));
      if (previewLoadingArtifactId === artifact.artifact_id) {
        setPreviewLoadingArtifactId(null);
      }
      setPreviewText(null);
      setPreviewError(null);
      showToast('Artifact hidden from the library');
    } catch {
      setError('Unable to delete artifact');
      showToast('Unable to delete artifact');
    } finally {
      setDeletingArtifactId(null);
    }
  }, [previewLoadingArtifactId, showToast]);

  const rootStyle = {
    '--active-accent': selectedArtifact?.accent ?? '#b8a4e8',
  } as CSSProperties;

  return (
    <section
      aria-labelledby="artifact-library-title"
      className={styles.observatory}
      data-testid="artifact-library-panel"
      style={rootStyle}
    >
      <ObservatoryCanvas selectedArtifact={selectedArtifact} />
      <main className={styles.stage}>
        <header className={styles.topLeft}>
          <p className={styles.kicker}>Sophia Observatory</p>
          <h1 id="artifact-library-title" className={styles.title}>
            Artifact Observatory
          </h1>
          <p className={styles.subtitle}>
            Durable works made with Sophia, suspended in a night field.
          </p>
        </header>

        <div className={styles.topRight}>
          <div className={styles.instrumentPill}>
            <span data-testid="artifact-library-count">{total} total</span>
            <span className={styles.countSuffix}> durable works</span>
          </div>
          <button
            type="button"
            aria-label="Refresh artifacts"
            onClick={() => setRefreshNonce((value) => value + 1)}
            className={styles.modeButton}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={cn(styles.modeButton, !atlasMode && styles.modeButtonActive)}
            onClick={() => setAtlasMode(false)}
          >
            Observe
          </button>
          <button
            type="button"
            className={cn(styles.modeButton, atlasMode && styles.modeButtonActive)}
            onClick={() => setAtlasMode(true)}
          >
            Atlas
          </button>
        </div>

        <div className={styles.controlDeck} data-testid="artifact-library-filters">
          <div className={styles.finderSurface}>
            <label className={styles.searchField}>
              <Search aria-hidden="true" />
              <span className={styles.srOnly}>Search artifacts</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search artifacts"
                className={styles.searchInput}
                placeholder="Search artifacts"
                spellCheck={false}
              />
            </label>
            <div className={styles.filterStrip}>
              {OBSERVATORY_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={cn(styles.filter, activeFilter === filter.value && styles.filterActive)}
                  onClick={() => setActiveFilter(filter.value)}
                  aria-pressed={activeFilter === filter.value}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {atlasMode && (
            <div className={styles.filterConsole}>
              <span className={styles.consoleGlyph} aria-hidden="true">
                <SlidersHorizontal />
              </span>
              <FilterButtonGroup
                label="Type"
                value={typeFilter}
                onChange={(value) => setTypeFilter(value as ArtifactTypeFilter)}
                options={TYPE_OPTIONS}
              />
              <FilterButtonGroup
                label="Source"
                value={sourceFilter}
                onChange={(value) => setSourceFilter(value as ArtifactSourceFilter)}
                options={SOURCE_OPTIONS}
              />
              <FilterButtonGroup
                label="Date"
                value={dateFilter}
                onChange={(value) => setDateFilter(value as ArtifactDateFilter)}
                options={DATE_OPTIONS}
              />
              <label className={styles.consoleField}>
                <span>Thread</span>
                <input
                  value={threadFilter}
                  onChange={(event) => setThreadFilter(event.target.value)}
                  aria-label="Thread"
                  placeholder="Thread"
                />
              </label>
            </div>
          )}
        </div>

        <div className={styles.hiddenControls}>
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
        </div>

        {error && (
          <div className={styles.error}>
            {error}
          </div>
        )}

        {loading ? (
          <ArtifactLibraryLoading />
        ) : visibleArtifacts.length === 0 ? (
          <ArtifactLibraryEmptyState />
        ) : (
          <div className={styles.artifactLayer} data-testid="artifact-library-list">
            {visibleArtifacts.map((artifact, index) => (
              <ArtifactStar
                key={artifact.artifact_id}
                artifact={artifact}
                selected={selectedArtifact?.artifact_id === artifact.artifact_id}
                index={index}
                onSelect={() => handleSelectArtifact(artifact)}
              />
            ))}
          </div>
        )}

        {selectedArtifact && !loading && (
          <ObservationPlate
            artifact={selectedArtifact}
            isOpen={openedArtifactId === selectedArtifact.artifact_id}
            previewText={previewText}
            previewLoading={previewLoadingArtifactId === selectedArtifact.artifact_id}
            previewError={previewError}
            opening={openingArtifactId === selectedArtifact.artifact_id}
            deleting={deletingArtifactId === selectedArtifact.artifact_id}
            onOpen={() => handleOpenInline(selectedArtifact)}
            onDelete={() => handleDeleteArtifact(selectedArtifact)}
          />
        )}

        {!loading && visibleArtifacts.length > 0 && (
          <FocusRail
            artifacts={visibleArtifacts}
            selectedArtifactId={selectedArtifact?.artifact_id ?? null}
            onSelect={(artifact) => handleSelectArtifact(artifact)}
          />
        )}

        <div className={cn(styles.toast, toastMessage && styles.toastShow)} role="status" aria-live="polite">
          {toastMessage}
        </div>
      </main>
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
    <label className={styles.consoleField}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
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

function FilterButtonGroup({
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
    <div className={styles.filterGroup} role="group" aria-label={`Filter by ${label}`}>
      <span className={styles.filterGroupLabel}>{label}</span>
      <div className={styles.filterGroupOptions}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={cn(styles.filterOption, value === option.value && styles.filterOptionActive)}
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
          >
            {compactFilterLabel(option.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ArtifactStar({
  artifact,
  selected,
  index,
  onSelect,
}: {
  artifact: ObservatoryArtifact;
  selected: boolean;
  index: number;
  onSelect: () => void;
}) {
  const label = artifact.title || artifact.filename;
  const style = {
    left: `${artifact.x * 100}%`,
    top: `${artifact.y * 100}%`,
    '--accent': artifact.accent,
    '--glow': artifact.glow,
    '--delay': `${(hashString(artifact.artifact_id) + index * 117) % 1600}ms`,
  } as CSSProperties;

  return (
    <button
      type="button"
      className={cn(styles.celestialArtifact, selected && styles.celestialArtifactActive)}
      style={style}
      onClick={onSelect}
      data-testid="artifact-library-row"
      data-selected={selected ? 'true' : 'false'}
      aria-label={`Select ${label}`}
    >
      <span className={styles.starTag}>
        <span className={styles.starTagHeader}>
          <strong>{label}</strong>
          <span className={styles.starAction}>Focus</span>
        </span>
        <span>{artifact.kindLabel} - {artifact.sourceLabel}</span>
        <span className={styles.testQuerySuffix}>{artifact.kindLabel}</span>
        <span className={styles.testQuerySuffix}>{artifact.sourceLabel}</span>
        <span>{artifact.filename}</span>
      </span>
    </button>
  );
}

function ObservationPlate({
  artifact,
  isOpen,
  previewText,
  previewLoading,
  previewError,
  opening,
  deleting,
  onOpen,
  onDelete,
}: {
  artifact: ObservatoryArtifact;
  isOpen: boolean;
  previewText: string | null;
  previewLoading: boolean;
  previewError: string | null;
  opening: boolean;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const label = artifact.title || artifact.filename;
  const contentHref = buildArtifactRegistryContentHref(artifact.artifact_id);
  const downloadHref = buildArtifactRegistryDownloadHref(artifact.artifact_id);

  return (
    <aside
      className={styles.artifactPlate}
      data-testid="artifact-library-detail"
      aria-label={`${label} artifact viewer`}
    >
      <div className={styles.plateHead}>
        <div className={styles.plateMeta}>
          <span>{artifact.kindLabel}</span>
          <span>{artifact.shortDateLabel}</span>
        </div>
        <div className={cn(styles.plateStatus, isOpen && styles.plateStatusOpen)}>
          <span className={styles.plateStatusDot} aria-hidden="true" />
          <span>{isOpen ? 'Opened in lens' : 'Focused star'}</span>
        </div>
        <h2 className={styles.plateTitle}>
          <SplitText text={label} />
        </h2>
        <p className={styles.plateFilename}>{artifact.filename}</p>
        <p className={styles.plateSummary}>{artifact.summary}</p>
      </div>

      <div className={cn(styles.previewLens, isOpen && styles.previewLensOpen)}>
        {isOpen || previewLoading || previewError ? (
          <div className={styles.realPreview}>
            <div className={styles.realPreviewChrome}>
              <span>Lens preview</span>
              <span>{artifact.kindLabel}</span>
            </div>
            <div className={styles.realPreviewBody}>
              <ArtifactLibraryPreview
                artifact={artifact}
                contentHref={contentHref}
                previewText={previewText}
                previewLoading={previewLoading}
                previewError={previewError}
              />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            disabled={opening || deleting}
            className={styles.previewOpenShell}
            aria-label={`Open ${label} inline`}
          >
            <PreviewCard artifact={artifact} />
            <span className={styles.lensAction}>
              {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              Open
            </span>
          </button>
        )}
      </div>

      <dl className={styles.plateData}>
        <MetadataItem label="Origin" value={artifact.sourceLabel} />
        <MetadataItem label="Storage" value={artifact.storageLabel} />
        <MetadataItem label="Opened" value={formatOpenedCount(artifact.opened_count)} />
      </dl>

      <div className={styles.plateActions}>
        <a
          href={downloadHref}
          className={styles.action}
          aria-label={`Download ${label}`}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Download
        </a>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting || opening}
          className={cn(styles.action, styles.actionDanger)}
          aria-label={`Delete ${label}`}
        >
          {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
          {!deleting && <Trash2 className="h-4 w-4" aria-hidden="true" />}
          Hide
        </button>
      </div>
    </aside>
  );
}

function PreviewCard({ artifact }: { artifact: ObservatoryArtifact }) {
  const previewIsDeck = artifact.kindLabel === 'PPTX';

  return (
    <div className={cn(styles.previewCard, previewClassFor(artifact))} aria-hidden="true">
      <div className={styles.previewChrome}>
        <span />
        <span />
        <span />
      </div>
      <div className={styles.previewType}>{artifact.kindLabel} preview</div>
      <div className={styles.previewTitle}>
        <SplitText text={previewTitleFor(artifact)} />
      </div>
      <div className={styles.previewBody}>
        {previewIsDeck ? (
          <>
            <span />
            <span />
            <span />
          </>
        ) : isGraphicPreviewCard(artifact) ? null : (
          <div className={styles.previewLines}>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <div className={styles.previewFoot}>{artifact.sourceLabel} - {artifact.storageLabel}</div>
    </div>
  );
}

function SplitText({ text }: { text: string }) {
  return (
    <>
      {Array.from(text).map((character, index) => (
        <span key={`${character}-${index}`}>{character}</span>
      ))}
    </>
  );
}

function previewClassFor(artifact: ObservatoryArtifact): string {
  if (artifact.kindLabel === 'PPTX') return styles.previewDeck;
  if (artifact.kindLabel === 'HTML') return styles.previewHtml;
  if (artifact.kindLabel === 'PDF') return styles.previewPdf;
  if (artifact.family === 'visual' || artifact.kindLabel === 'Image') return styles.previewImage;
  return styles.previewDocument;
}

function previewTitleFor(artifact: ObservatoryArtifact): string {
  if (artifact.kindLabel === 'PPTX') return 'Deck outline';
  const label = artifact.title || artifact.filename;
  return label.split(/\s+/u).slice(0, 3).join(' ');
}

function isGraphicPreviewCard(artifact: ObservatoryArtifact): boolean {
  return artifact.kindLabel === 'HTML'
    || artifact.kindLabel === 'PDF'
    || artifact.family === 'visual'
    || artifact.kindLabel === 'Image';
}

function formatOpenedCount(count: number): string {
  return count === 1 ? '1 time' : `${count} times`;
}

function compactFilterLabel(label: string): string {
  if (label === 'All types' || label === 'All sources') return 'All';
  if (label === 'Quick edit') return 'Edit';
  if (label === 'Coreview') return 'Review';
  if (label === 'Markdown') return 'MD';
  return label;
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
        <div className={styles.previewLoading} data-testid="artifact-library-preview-loading">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      );
    }
    if (previewError) {
      return <PreviewUnavailable message={previewError} />;
    }
    if (previewText !== null) {
      return (
        <div className={styles.markdownPreview} data-testid="artifact-library-markdown-preview">
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
        className={styles.htmlPreview}
        data-testid="artifact-library-html-preview"
      />
    );
  }

  if (isPdfArtifact(artifact)) {
    return (
      <iframe
        src={contentHref}
        title={`${label} PDF preview`}
        className={styles.pdfPreview}
        data-testid="artifact-library-pdf-preview"
      />
    );
  }

  if (isImageArtifact(artifact)) {
    return (
      <img
        src={contentHref}
        alt={label}
        className={styles.imagePreview}
        data-testid="artifact-library-image-preview"
      />
    );
  }

  return <PreviewUnavailable message="Native preview unavailable" />;
}

function PreviewUnavailable({ message }: { message: string }) {
  return (
    <div className={styles.previewUnavailable} data-testid="artifact-library-preview-unavailable">
      {message}
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.datum}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ArtifactLibraryLoading() {
  return (
    <div className={styles.loadingState} data-testid="artifact-library-loading">
      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
      <p className="mt-3 text-[13px]">Calibrating the observatory</p>
    </div>
  );
}

function ArtifactLibraryEmptyState() {
  return (
    <div className={styles.emptyState} data-testid="artifact-library-empty">
      <FileText className="mx-auto h-8 w-8 opacity-60" />
      <p className="mt-3 text-[15px] font-medium">No artifacts yet</p>
    </div>
  );
}

function FocusRail({
  artifacts,
  selectedArtifactId,
  onSelect,
}: {
  artifacts: ObservatoryArtifact[];
  selectedArtifactId: string | null;
  onSelect: (artifact: ObservatoryArtifact) => void;
}) {
  const selected = artifacts.find((artifact) => artifact.artifact_id === selectedArtifactId) ?? artifacts[0];

  return (
    <div className={styles.focusRail}>
      <div className={styles.railCopy}>
        <span>{selected?.dateLabel ?? 'Unknown'}</span>
        <span>{artifacts.length} works in view</span>
      </div>
      <div className={styles.railTrack}>
        <div className={styles.railLine} />
        {artifacts.map((artifact, index) => {
          const left = artifacts.length <= 1 ? 50 : (index / (artifacts.length - 1)) * 100;
          return (
            <button
              key={artifact.artifact_id}
              type="button"
              className={cn(
                styles.railDot,
                artifact.artifact_id === selectedArtifactId && styles.railDotActive,
              )}
              style={{
                left: `${left}%`,
                '--active-accent': artifact.accent,
              } as CSSProperties}
              onClick={() => onSelect(artifact)}
              aria-label={`Focus ${artifact.title || artifact.filename}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function ObservatoryCanvas({ selectedArtifact }: { selectedArtifact: ObservatoryArtifact | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ArtifactObservatoryRenderer | null>(null);
  const fallbackTargetRef = useRef<ObservatoryArtifact | null>(selectedArtifact);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    if (typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('jsdom')) {
      return undefined;
    }

    const webglRenderer = createArtifactObservatoryRenderer(
      canvas,
      selectedToRenderTarget(fallbackTargetRef.current),
    );
    if (webglRenderer) {
      rendererRef.current = webglRenderer;
      return () => {
        webglRenderer.dispose();
        rendererRef.current = null;
      };
    }

    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d');
    } catch {
      return undefined;
    }
    if (!context) return undefined;

    let animationFrame = 0;
    const stars = Array.from({ length: 420 }, (_, index) => {
      const seed = hashString(`star-${index}`);
      return {
        x: ((seed * 9301 + 49297) % 233280) / 233280,
        y: (((seed + 101) * 9301 + 49297) % 233280) / 233280,
        size: 0.45 + (seed % 11) / 12,
        pulse: (seed % 1000) / 1000,
      };
    });

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.7);
      const targetWidth = Math.max(1, Math.floor(width * dpr));
      const targetHeight = Math.max(1, Math.floor(height * dpr));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      const ctx = context;
      const now = performance.now() / 1000;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const sky = ctx.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, '#02020a');
      sky.addColorStop(0.28, '#06061a');
      sky.addColorStop(0.62, '#080616');
      sky.addColorStop(1, '#010105');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);

      drawMilkyWay(ctx, width, height, now);
      drawStars(ctx, stars, width, height, now);
      drawComets(ctx, width, height, now);
      drawHorizon(ctx, width, height, now);
      drawBeam(ctx, width, height, fallbackTargetRef.current, now);
      drawIslandAndObservatory(ctx, width, height, now);
      drawWater(ctx, width, height, fallbackTargetRef.current, now);
      drawVignette(ctx, width, height);

      ctx.restore();
      animationFrame = window.requestAnimationFrame(draw);
    };

    animationFrame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    fallbackTargetRef.current = selectedArtifact;
    rendererRef.current?.update(selectedToRenderTarget(selectedArtifact));
  }, [selectedArtifact]);

  return <canvas ref={canvasRef} className={styles.cinema} aria-hidden="true" />;
}

function selectedToRenderTarget(selectedArtifact: ObservatoryArtifact | null) {
  const defaultTarget = FIELD_POSITIONS[0];
  return {
    x: selectedArtifact?.x ?? defaultTarget.x,
    y: selectedArtifact?.y ?? defaultTarget.y,
    accent: selectedArtifact?.accent ?? ACCENTS[0].accent,
  };
}

function drawMilkyWay(ctx: CanvasRenderingContext2D, width: number, height: number, now: number) {
  ctx.save();
  ctx.translate(width * 0.50, height * 0.24);
  ctx.rotate(-0.10);
  for (let layer = 0; layer < 8; layer += 1) {
    const alpha = 0.05 + layer * 0.011;
    const gradient = ctx.createRadialGradient(0, 0, 20, 0, 0, width * (0.42 + layer * 0.035));
    gradient.addColorStop(0, `rgba(245, 232, 255, ${alpha + 0.05})`);
    gradient.addColorStop(0.28, `rgba(184, 164, 232, ${alpha})`);
    gradient.addColorStop(0.58, `rgba(97, 200, 187, ${alpha * 0.40})`);
    gradient.addColorStop(1, 'rgba(1, 1, 6, 0)');
    ctx.fillStyle = gradient;
    ctx.filter = `blur(${18 + layer * 8}px)`;
    ctx.beginPath();
    ctx.ellipse(
      Math.sin(now * 0.035 + layer) * 6,
      Math.cos(now * 0.030 + layer) * 4,
      width * (0.46 + layer * 0.05),
      height * (0.040 + layer * 0.010),
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.filter = 'none';
  for (let i = 0; i < 180; i += 1) {
    const seed = hashString(`dust-${i}`);
    const x = ((seed % 1000) / 1000 - 0.5) * width * 1.22;
    const y = (((seed >> 9) % 1000) / 1000 - 0.5) * height * 0.18;
    const opacity = 0.08 + ((seed >> 15) % 100) / 900;
    ctx.fillStyle = `rgba(255, 246, 255, ${opacity})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.35 + (seed % 5) * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStars(
  ctx: CanvasRenderingContext2D,
  stars: Array<{ x: number; y: number; size: number; pulse: number }>,
  width: number,
  height: number,
  now: number,
) {
  ctx.save();
  for (const star of stars) {
    if (star.y > 0.78) continue;
    const twinkle = 0.34 + Math.sin(now * 0.9 + star.pulse * 8) * 0.16;
    ctx.fillStyle = `rgba(230, 236, 255, ${twinkle})`;
    ctx.beginPath();
    ctx.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawComets(ctx: CanvasRenderingContext2D, width: number, height: number, now: number) {
  ctx.save();
  for (let i = 0; i < 3; i += 1) {
    const cycle = (now * 0.038 + i * 0.37) % 1;
    const x = width * (1.08 - cycle * 1.32);
    const y = height * (0.14 + i * 0.12 + cycle * 0.16);
    const tail = 120 + i * 36;
    const gradient = ctx.createLinearGradient(x, y, x + tail, y - tail * 0.16);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.70)');
    gradient.addColorStop(0.22, 'rgba(184, 164, 232, 0.20)');
    gradient.addColorStop(1, 'rgba(184, 164, 232, 0)');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.1 + i * 0.35;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + tail, y - tail * 0.16);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.beginPath();
    ctx.arc(x, y, 1.4 + i * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHorizon(ctx: CanvasRenderingContext2D, width: number, height: number, now: number) {
  const horizon = height * 0.72;
  ctx.save();
  ctx.fillStyle = 'rgba(3, 3, 10, 0.96)';
  ctx.beginPath();
  ctx.moveTo(0, horizon + 48);
  for (let x = 0; x <= width; x += 18) {
    const y = horizon + Math.sin(x * 0.009 + now * 0.18) * 10 + Math.sin(x * 0.021) * 5;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  const fog = ctx.createLinearGradient(0, horizon - 80, 0, horizon + 46);
  fog.addColorStop(0, 'rgba(184, 164, 232, 0)');
  fog.addColorStop(0.52, 'rgba(184, 164, 232, 0.08)');
  fog.addColorStop(1, 'rgba(97, 200, 187, 0.04)');
  ctx.fillStyle = fog;
  ctx.fillRect(0, horizon - 90, width, 150);
  ctx.restore();
}

function drawBeam(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  selectedArtifact: ObservatoryArtifact | null,
  now: number,
) {
  const origin = { x: width * 0.50, y: height * 0.82 };
  const target = {
    x: width * (selectedArtifact?.x ?? 0.42),
    y: height * (selectedArtifact?.y ?? 0.34),
  };
  const accent = selectedArtifact?.accent ?? '#b8a4e8';

  ctx.save();
  for (let layer = 0; layer < 7; layer += 1) {
    const widthScale = 8 + layer * 16 + Math.sin(now * 1.8 + layer) * 2;
    const alpha = 0.16 / (layer + 1);
    const gradient = ctx.createLinearGradient(origin.x, origin.y, target.x, target.y);
    gradient.addColorStop(0, `rgba(255, 255, 255, ${0.22 - layer * 0.012})`);
    gradient.addColorStop(0.38, colorWithAlpha(accent, alpha * 1.5));
    gradient.addColorStop(0.86, `rgba(255, 255, 255, ${0.20 - layer * 0.014})`);
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = widthScale;
    ctx.filter = `blur(${layer * 3}px)`;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    const controlX = width * (0.47 + Math.sin(now * 0.24) * 0.02);
    const controlY = height * 0.58;
    ctx.quadraticCurveTo(controlX, controlY, target.x, target.y);
    ctx.stroke();
  }
  ctx.filter = 'none';
  ctx.fillStyle = colorWithAlpha(accent, 0.22);
  ctx.beginPath();
  ctx.arc(target.x, target.y, 36 + Math.sin(now * 2.2) * 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawIslandAndObservatory(ctx: CanvasRenderingContext2D, width: number, height: number, now: number) {
  const baseY = height * 0.84;
  const centerX = width * 0.50;

  ctx.save();
  const island = ctx.createLinearGradient(0, baseY - 90, 0, baseY + 70);
  island.addColorStop(0, 'rgba(20, 18, 34, 0.96)');
  island.addColorStop(0.58, 'rgba(7, 7, 15, 0.98)');
  island.addColorStop(1, 'rgba(1, 1, 5, 1)');
  ctx.fillStyle = island;
  ctx.beginPath();
  ctx.moveTo(centerX - 180, baseY + 22);
  ctx.bezierCurveTo(centerX - 150, baseY - 58, centerX - 86, baseY - 86, centerX - 18, baseY - 70);
  ctx.bezierCurveTo(centerX + 46, baseY - 100, centerX + 144, baseY - 46, centerX + 184, baseY + 26);
  ctx.quadraticCurveTo(centerX, baseY + 58, centerX - 180, baseY + 22);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(184, 164, 232, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centerX - 170, baseY + 20);
  ctx.bezierCurveTo(centerX - 80, baseY + 42, centerX + 70, baseY + 44, centerX + 178, baseY + 24);
  ctx.stroke();

  const domeY = baseY - 70;
  ctx.fillStyle = 'rgba(6, 6, 13, 0.98)';
  ctx.fillRect(centerX - 54, domeY + 42, 108, 30);
  const domeGradient = ctx.createRadialGradient(centerX - 22, domeY + 4, 10, centerX, domeY + 34, 72);
  domeGradient.addColorStop(0, 'rgba(196, 181, 232, 0.28)');
  domeGradient.addColorStop(0.44, 'rgba(32, 28, 48, 0.94)');
  domeGradient.addColorStop(1, 'rgba(5, 5, 12, 1)');
  ctx.fillStyle = domeGradient;
  ctx.beginPath();
  ctx.arc(centerX, domeY + 42, 58, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(240, 236, 247, 0.10)';
  ctx.stroke();

  ctx.save();
  ctx.translate(centerX, domeY + 42);
  ctx.rotate(-0.58 + Math.sin(now * 0.18) * 0.025);
  ctx.fillStyle = 'rgba(16, 15, 26, 0.98)';
  ctx.fillRect(-10, -64, 20, 66);
  ctx.fillStyle = 'rgba(38, 34, 56, 0.98)';
  ctx.fillRect(-18, -76, 36, 18);
  ctx.restore();

  ctx.restore();
}

function drawWater(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  selectedArtifact: ObservatoryArtifact | null,
  now: number,
) {
  const waterY = height * 0.84;
  const accent = selectedArtifact?.accent ?? '#b8a4e8';
  ctx.save();
  const water = ctx.createLinearGradient(0, waterY - 28, 0, height);
  water.addColorStop(0, 'rgba(5, 8, 18, 0.20)');
  water.addColorStop(0.46, 'rgba(3, 7, 15, 0.72)');
  water.addColorStop(1, 'rgba(0, 1, 5, 0.98)');
  ctx.fillStyle = water;
  ctx.fillRect(0, waterY - 28, width, height - waterY + 28);

  for (let i = 0; i < 34; i += 1) {
    const y = waterY + i * 9 + Math.sin(now * 0.7 + i * 0.6) * 2;
    const alpha = Math.max(0, 0.11 - i * 0.0022);
    ctx.strokeStyle = `rgba(184, 164, 232, ${alpha})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 22) {
      const wave = Math.sin(x * 0.014 + now * 0.9 + i) * (3 + i * 0.045);
      if (x === 0) ctx.moveTo(x, y + wave);
      else ctx.lineTo(x, y + wave);
    }
    ctx.stroke();
  }

  const reflection = ctx.createRadialGradient(width * 0.50, waterY + 34, 10, width * 0.50, waterY + 34, width * 0.34);
  reflection.addColorStop(0, colorWithAlpha(accent, 0.18));
  reflection.addColorStop(0.28, 'rgba(255, 255, 255, 0.06)');
  reflection.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = reflection;
  ctx.beginPath();
  ctx.ellipse(width * 0.50, waterY + 40, width * 0.26, height * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const gradient = ctx.createRadialGradient(width * 0.5, height * 0.42, height * 0.18, width * 0.5, height * 0.5, height * 0.82);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(0.68, 'rgba(0, 0, 0, 0.12)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.82)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function toObservatoryArtifact(record: ArtifactRegistryRecord, index: number): ObservatoryArtifact {
  const seed = hashString(`${record.artifact_id}:${record.version_id}:${record.filename}`);
  const base = FIELD_POSITIONS[index % FIELD_POSITIONS.length];
  const overflowRing = Math.floor(index / FIELD_POSITIONS.length);
  const offsetX = index < FIELD_POSITIONS.length ? 0 : (((seed % 100) / 100) - 0.5) * 0.08;
  const offsetY = index < FIELD_POSITIONS.length ? 0 : ((((seed >> 8) % 100) / 100) - 0.5) * 0.07;
  const color = ACCENTS[index % ACCENTS.length];
  const kindLabel = formatArtifactType(record.artifact_type);
  const sourceLabel = formatSource(record.source);
  const summary = record.safe_summary?.trim()
    || `${kindLabel} preserved from ${sourceLabel}.`;

  return {
    ...record,
    accent: color.accent,
    glow: color.glow,
    x: clamp(base.x + offsetX + overflowRing * 0.018, 0.08, 0.91),
    y: clamp(base.y + offsetY - overflowRing * 0.012, 0.16, 0.73),
    family: familyForArtifact(record),
    kindLabel,
    sourceLabel,
    dateLabel: formatDate(record.created_at),
    shortDateLabel: formatShortDate(record.created_at),
    storageLabel: formatStorageStatus(record.storage_status),
    summary,
  };
}

function matchesObservatoryFilter(artifact: ObservatoryArtifact, filter: ObservatoryFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'builder') return artifact.source === 'builder';
  if (filter === 'recent') return Boolean(artifact.last_opened_at || artifact.opened_count > 0);
  if (filter === 'document') return artifact.family === 'document' || artifact.family === 'deck';
  if (filter === 'visual') return artifact.family === 'visual' || artifact.family === 'deck';
  return true;
}

function familyForArtifact(artifact: ArtifactRegistryRecord): ObservatoryFamily {
  const normalizedType = artifact.artifact_type.toLowerCase();
  const normalizedRenderer = String(artifact.renderer_kind || '').toLowerCase();
  if (normalizedType === 'pptx' || artifact.filename.toLowerCase().endsWith('.pptx')) return 'deck';
  if (normalizedType === 'image' || normalizedRenderer === 'image') return 'visual';
  if (
    normalizedType === 'html'
    || normalizedType === 'pdf'
    || normalizedType === 'markdown'
    || normalizedRenderer === 'html'
    || normalizedRenderer === 'markdown'
    || normalizedRenderer === 'pdf'
  ) {
    return 'document';
  }
  return 'other';
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function colorWithAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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

function formatShortDate(value: string | null | undefined): string {
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
