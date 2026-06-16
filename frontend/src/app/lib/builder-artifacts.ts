import type {
  BuilderArtifactFileV1,
  BuilderArtifactV1,
} from '../types/builder-artifact';

import { asRecord, readNumber, readString } from './record-parsers';

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function coerceString(record: Record<string, unknown>, snakeKey: string, camelKey?: string): string | undefined {
  return readString(record, snakeKey) ?? (camelKey ? readString(record, camelKey) : undefined);
}

function coerceStringArray(record: Record<string, unknown>, snakeKey: string, camelKey?: string): string[] {
  return readStringArray(record[snakeKey] ?? (camelKey ? record[camelKey] : undefined));
}

function coerceNumber(record: Record<string, unknown>, snakeKey: string, camelKey?: string): number | undefined {
  return readNumber(record, snakeKey) ?? (camelKey ? readNumber(record, camelKey) : undefined);
}

function sanitizeArtifactPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^file:\/\//, '');
}

export function normalizeBuilderArtifactPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') {
    return null;
  }

  const sanitized = sanitizeArtifactPath(path);
  if (!sanitized) {
    return null;
  }

  if (sanitized.startsWith('/mnt/user-data/outputs/')) {
    return sanitized.slice(1);
  }

  if (sanitized.startsWith('mnt/user-data/outputs/')) {
    return sanitized;
  }

  const userDataOutputsIndex = sanitized.indexOf('/user-data/outputs/');
  if (userDataOutputsIndex >= 0) {
    return `mnt${sanitized.slice(userDataOutputsIndex)}`;
  }

  if (sanitized.startsWith('/user-data/outputs/')) {
    return `mnt${sanitized}`;
  }

  if (sanitized.startsWith('user-data/outputs/')) {
    return `mnt/${sanitized}`;
  }

  if (sanitized.startsWith('/outputs/')) {
    return `mnt/user-data${sanitized}`;
  }

  if (sanitized.startsWith('outputs/')) {
    return `mnt/user-data/${sanitized}`;
  }

  return sanitized.replace(/^\/+/, '');
}

function getFallbackTitle(artifactPath: string | undefined): string {
  if (!artifactPath) {
    return 'Builder deliverable';
  }

  const name = artifactPath.split('/').filter(Boolean).pop() || artifactPath;
  return name;
}

export function normalizeBuilderArtifactPayload(raw: unknown): BuilderArtifactV1 | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const rawArtifactTitle = coerceString(record, 'artifact_title', 'artifactTitle');
  const artifactPath = normalizeBuilderArtifactPath(
    coerceString(record, 'artifact_path', 'artifactPath')
  ) || undefined;
  const supportingFiles = coerceStringArray(record, 'supporting_files', 'supportingFiles')
    .map((path) => normalizeBuilderArtifactPath(path))
    .filter((path): path is string => typeof path === 'string');
  const decisionsMade = coerceStringArray(record, 'decisions_made', 'decisionsMade').slice(0, 4);
  const sourcesUsed = coerceStringArray(record, 'sources_used', 'sourcesUsed');
  const artifactTitle = rawArtifactTitle || getFallbackTitle(artifactPath);
  const artifactPreviewFilename = coerceString(record, 'artifact_preview_filename', 'artifactPreviewFilename');
  const companionSummary = coerceString(record, 'companion_summary', 'companionSummary');
  const userNextAction = coerceString(record, 'user_next_action', 'userNextAction');

  if (
    !artifactPath &&
    supportingFiles.length === 0 &&
    !companionSummary &&
    !userNextAction &&
    !rawArtifactTitle
  ) {
    return null;
  }

  return {
    ...(artifactPath ? { artifactPath } : {}),
    artifactType: coerceString(record, 'artifact_type', 'artifactType') || 'unknown',
    artifactTitle,
    ...(artifactPreviewFilename ? { artifactPreviewFilename } : {}),
    ...(supportingFiles.length > 0 ? { supportingFiles } : {}),
    ...(coerceNumber(record, 'steps_completed', 'stepsCompleted') !== undefined
      ? { stepsCompleted: coerceNumber(record, 'steps_completed', 'stepsCompleted') }
      : {}),
    decisionsMade,
    ...(sourcesUsed.length > 0 ? { sourcesUsed } : {}),
    ...(companionSummary ? { companionSummary } : {}),
    ...(coerceString(record, 'companion_tone_hint', 'companionToneHint')
      ? { companionToneHint: coerceString(record, 'companion_tone_hint', 'companionToneHint') }
      : {}),
    ...(userNextAction ? { userNextAction } : {}),
    ...(coerceNumber(record, 'confidence') !== undefined
      ? { confidence: coerceNumber(record, 'confidence') }
      : {}),
  };
}

function getFileLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

const PPTX_PREVIEW_PDF_SUFFIX = '.preview.pdf';
const RENDER_SOURCE_SIBLING_PATTERN = /\.(?:pdf|pptx?|docx?|html?)\.(?:md|markdown)$/iu;
const DELIVERABLE_EXTENSION_PRIORITY = ['pdf', 'pptx', 'ppt', 'html', 'htm', 'md', 'markdown'];

export type BuilderArtifactFileRole = 'deliverable' | 'source' | 'preview';

interface BuilderArtifactFileLike {
  path?: string | null;
  name?: string | null;
  mimeType?: string | null;
}

function fileBaseName(file: BuilderArtifactFileLike | null | undefined): string {
  const value = (typeof file?.name === 'string' && file.name.trim())
    || (typeof file?.path === 'string' && file.path.trim())
    || '';
  return value.split('/').filter(Boolean).pop() ?? '';
}

function fileExtension(file: BuilderArtifactFileLike | null | undefined): string {
  const name = fileBaseName(file).toLowerCase().split(/[?#]/u)[0] ?? '';
  const match = /\.([a-z0-9]+)$/u.exec(name);
  return match?.[1] ?? '';
}

export function isPptxArtifactFile(file: BuilderArtifactFileLike | null | undefined): boolean {
  const mimeType = file?.mimeType?.toLowerCase().split(';')[0]?.trim() ?? '';
  if (
    mimeType === 'application/vnd.ms-powerpoint'
    || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return true;
  }
  const extension = fileExtension(file);
  return extension === 'ppt' || extension === 'pptx';
}

/**
 * Base stem used to group a deliverable with its render-source and preview
 * siblings: ``sophia-roadmap.pdf``, ``sophia-roadmap.pdf.md`` and
 * ``sophia-roadmap.preview.pdf`` all share the stem ``sophia-roadmap``.
 */
export function getBuilderArtifactFileBaseStem(file: BuilderArtifactFileLike | null | undefined): string {
  let name = fileBaseName(file).toLowerCase().split(/[?#]/u)[0] ?? '';
  if (name.endsWith(PPTX_PREVIEW_PDF_SUFFIX)) {
    return name.slice(0, -PPTX_PREVIEW_PDF_SUFFIX.length);
  }
  const sourceMatch = RENDER_SOURCE_SIBLING_PATTERN.exec(name);
  if (sourceMatch) {
    name = name.slice(0, name.length - sourceMatch[0].length);
    return name;
  }
  return name.replace(/\.[a-z0-9]+$/u, '');
}

/**
 * Classifies a file against its siblings so render sources (``report.pdf.md``,
 * ``deck.md`` next to ``deck.pptx``) and deck previews (``deck.preview.pdf``)
 * never outrank the requested deliverable.
 */
export function classifyBuilderArtifactFileRole(
  file: BuilderArtifactFileLike | null | undefined,
  siblings: readonly BuilderArtifactFileLike[] = [],
): BuilderArtifactFileRole {
  const name = fileBaseName(file).toLowerCase();
  if (!name) {
    return 'deliverable';
  }
  if (name.endsWith(PPTX_PREVIEW_PDF_SUFFIX)) {
    return 'preview';
  }
  if (RENDER_SOURCE_SIBLING_PATTERN.test(name)) {
    return 'source';
  }
  const extension = fileExtension(file);
  if (extension === 'md' || extension === 'markdown') {
    const stem = getBuilderArtifactFileBaseStem(file);
    const hasRenderedSibling = siblings.some((sibling) => {
      if (!sibling || sibling === file) {
        return false;
      }
      const siblingName = fileBaseName(sibling).toLowerCase();
      if (!siblingName || siblingName === name) {
        return false;
      }
      const siblingExtension = fileExtension(sibling);
      return ['pdf', 'pptx', 'ppt'].includes(siblingExtension)
        && getBuilderArtifactFileBaseStem(sibling) === stem;
    });
    if (hasRenderedSibling) {
      return 'source';
    }
  }
  return 'deliverable';
}

export function formatBuilderArtifactFileRoleLabel(role: BuilderArtifactFileRole): string | null {
  if (role === 'source') {
    return 'Source';
  }
  if (role === 'preview') {
    return 'Preview';
  }
  return null;
}

function deliverableExtensionRank(file: BuilderArtifactFileLike): number {
  const index = DELIVERABLE_EXTENSION_PRIORITY.indexOf(fileExtension(file));
  return index === -1 ? DELIVERABLE_EXTENSION_PRIORITY.length : index;
}

/**
 * Ranks an artifact file list so the requested deliverable wins regardless of
 * mtime: render-source and preview siblings sink below deliverables, and files
 * sharing a base stem order by extension priority (pdf > pptx > html > md).
 * Unrelated files keep their incoming (newest-first) order — the sort is
 * stable.
 */
export function rankBuilderArtifactLibraryItems<T extends BuilderArtifactFileLike>(items: readonly T[]): T[] {
  const roles = new Map<T, BuilderArtifactFileRole>();
  for (const item of items) {
    roles.set(item, classifyBuilderArtifactFileRole(item, items));
  }
  const roleRank = (item: T) => (roles.get(item) === 'deliverable' ? 0 : 1);
  return [...items].sort((left, right) => {
    const roleDelta = roleRank(left) - roleRank(right);
    if (roleDelta !== 0) {
      return roleDelta;
    }
    if (getBuilderArtifactFileBaseStem(left) === getBuilderArtifactFileBaseStem(right)) {
      return deliverableExtensionRank(left) - deliverableExtensionRank(right);
    }
    return 0;
  });
}

export type BuilderCanvasPreviewKind = 'pptx_pdf_preview';

export interface ResolvedCanvasRenderFile<T extends BuilderArtifactFileLike> {
  /** File the canvas should render (the .preview.pdf sibling for decks). */
  renderFile: T | null;
  /** File download / open-original affordances must keep pointing at. */
  downloadFile: T | null;
  previewKind: BuilderCanvasPreviewKind | null;
}

/**
 * Resolves which file the canvas renders versus which file download/open
 * affordances target. When the primary deliverable is a PPTX and a rendered
 * ``<stem>.preview.pdf`` sibling exists (preferred name comes from the
 * completion event's ``artifact_preview_filename`` when present), the preview
 * renders through the existing PDF pipeline while downloads keep the deck.
 */
export function resolveCanvasRenderFile<T extends BuilderArtifactFileLike & { isPrimary?: boolean }>(
  files: readonly T[],
  artifact?: Pick<BuilderArtifactV1, 'artifactPreviewFilename'> | null,
): ResolvedCanvasRenderFile<T> {
  const list = files.filter((file): file is T => Boolean(file));
  const downloadFile = list.find((file) => file.isPrimary) ?? list[0] ?? null;
  if (!downloadFile || !isPptxArtifactFile(downloadFile)) {
    return { renderFile: downloadFile, downloadFile, previewKind: null };
  }

  const explicitPreviewName = artifact?.artifactPreviewFilename?.trim().split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  const primaryName = fileBaseName(downloadFile).toLowerCase();
  const primaryStem = primaryName.replace(/\.pptx?$/u, '');
  const stemPreviewName = `${primaryStem}${PPTX_PREVIEW_PDF_SUFFIX}`;
  const findByName = (candidateName: string) => (
    candidateName
      ? list.find((file) => file !== downloadFile && fileBaseName(file).toLowerCase() === candidateName) ?? null
      : null
  );
  const previewFile = findByName(explicitPreviewName) ?? findByName(stemPreviewName);
  if (!previewFile) {
    return { renderFile: downloadFile, downloadFile, previewKind: null };
  }
  return { renderFile: previewFile, downloadFile, previewKind: 'pptx_pdf_preview' };
}

export function getBuilderArtifactFiles(builderArtifact: BuilderArtifactV1 | null | undefined): BuilderArtifactFileV1[] {
  if (!builderArtifact) {
    return [];
  }

  const seen = new Set<string>();
  const files: BuilderArtifactFileV1[] = [];

  const addFile = (path: string | undefined, isPrimary: boolean) => {
    if (!path || seen.has(path)) {
      return;
    }

    seen.add(path);
    files.push({
      path,
      name: getFileLabel(path),
      label: getFileLabel(path),
      isPrimary,
    });
  };

  addFile(builderArtifact.artifactPath, true);
  for (const supportingFile of builderArtifact.supportingFiles || []) {
    addFile(supportingFile, false);
  }

  return files;
}

export function buildThreadArtifactHref(
  threadId: string | null | undefined,
  artifactPath: string | null | undefined,
  options?: { download?: boolean },
): string | null {
  if (!threadId) {
    return null;
  }

  const normalizedPath = normalizeBuilderArtifactPath(artifactPath);
  if (!normalizedPath) {
    return null;
  }

  const encodedPath = normalizedPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  const baseHref = `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodedPath}`;
  return options?.download ? `${baseHref}?download=true` : baseHref;
}

export function buildArtifactRegistryHref(
  artifactId: string | null | undefined,
  options?: { download?: boolean },
): string | null {
  const normalizedArtifactId = artifactId?.trim();
  if (!normalizedArtifactId) {
    return null;
  }
  const action = options?.download ? 'download' : 'content';
  return `/api/artifacts/${encodeURIComponent(normalizedArtifactId)}/${action}`;
}

export interface ArtifactHrefInput {
  threadId?: string | null;
  artifactPath?: string | null;
  localPath?: string | null;
  local_path?: string | null;
  artifactId?: string | null;
  artifact_id?: string | null;
  contentUrl?: string | null;
  content_url?: string | null;
  downloadUrl?: string | null;
  download_url?: string | null;
  storageProvider?: string | null;
  storage_provider?: string | null;
  storageBucket?: string | null;
  storage_bucket?: string | null;
  storageObjectPath?: string | null;
  storage_object_path?: string | null;
  preferArtifactId?: boolean;
}

function normalizeSafeArtifactHref(value: string | null | undefined): string | null {
  const href = value?.trim();
  if (!href) {
    return null;
  }
  if (href.startsWith('/api/artifacts/')) {
    return href;
  }
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin === window.location.origin && url.pathname.startsWith('/api/artifacts/')) {
        return `${url.pathname}${url.search}${url.hash}`;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeArtifactHrefToken(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isLocalGeneratedArtifactId(artifactId: string | null): boolean {
  return Boolean(artifactId?.startsWith('artifact:'));
}

export function hasDurableArtifactReference(input: ArtifactHrefInput | null | undefined): boolean {
  if (!input) {
    return false;
  }
  const artifactId = normalizeArtifactHrefToken(input.artifactId ?? input.artifact_id);
  const storageProvider = normalizeArtifactHrefToken(input.storageProvider ?? input.storage_provider);
  return (
    Boolean(artifactId && !isLocalGeneratedArtifactId(artifactId))
    || Boolean(storageProvider && storageProvider !== 'local')
    || Boolean(normalizeArtifactHrefToken(input.storageBucket ?? input.storage_bucket))
    || Boolean(normalizeArtifactHrefToken(input.storageObjectPath ?? input.storage_object_path))
    || Boolean(normalizeSafeArtifactHref(input.contentUrl ?? input.content_url))
    || Boolean(normalizeSafeArtifactHref(input.downloadUrl ?? input.download_url))
  );
}

export function buildArtifactHref(
  input: ArtifactHrefInput,
  options?: { download?: boolean },
): string | null {
  const artifactId = normalizeArtifactHrefToken(input.artifactId ?? input.artifact_id);
  const preferArtifactId = Boolean(
    artifactId
      && !isLocalGeneratedArtifactId(artifactId)
      && (input.preferArtifactId ?? hasDurableArtifactReference(input))
  );
  const primaryExplicitHref = normalizeSafeArtifactHref(
    options?.download
      ? input.downloadUrl ?? input.download_url
      : input.contentUrl ?? input.content_url,
  );
  const alternateExplicitHref = normalizeSafeArtifactHref(
    options?.download
      ? input.contentUrl ?? input.content_url
      : input.downloadUrl ?? input.download_url,
  );

  if (preferArtifactId) {
    const registryHref = buildArtifactRegistryHref(artifactId, options);
    if (registryHref) {
      return registryHref;
    }
  }
  if (primaryExplicitHref) {
    return primaryExplicitHref;
  }
  if (alternateExplicitHref) {
    return alternateExplicitHref;
  }
  return buildThreadArtifactHref(
    input.threadId,
    input.artifactPath ?? input.localPath ?? input.local_path,
    options,
  );
}

export function isMarkdownArtifactFile(
  file: {
    path?: string | null;
    name?: string | null;
    mimeType?: string | null;
  } | null | undefined,
): boolean {
  if (!file) {
    return false;
  }

  const mimeType = file.mimeType?.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') {
    return true;
  }

  const hasMarkdownExtension = (value: string | null | undefined) => (
    typeof value === 'string' && /\.(md|markdown)(?:$|[?#])/u.test(value.toLowerCase())
  );

  return hasMarkdownExtension(file.name) || hasMarkdownExtension(file.path);
}

export function isHtmlArtifactFile(
  file: {
    path?: string | null;
    name?: string | null;
    mimeType?: string | null;
  } | null | undefined,
): boolean {
  if (!file) {
    return false;
  }

  const mimeType = file.mimeType?.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    return true;
  }

  const hasHtmlExtension = (value: string | null | undefined) => (
    typeof value === 'string' && /\.(html|htm)(?:$|[?#])/u.test(value.toLowerCase())
  );

  return hasHtmlExtension(file.name) || hasHtmlExtension(file.path);
}

export function formatBuilderArtifactFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatBuilderArtifactTypeLabel(type: string | undefined): string {
  if (!type) {
    return 'Deliverable';
  }

  return type
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
