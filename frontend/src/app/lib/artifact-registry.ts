import type { ArtifactRendererKind } from './artifact-renderers';
import { normalizeBuilderArtifactPath } from './builder-artifacts';
import type { ArtifactRegisterSource, RegisterArtifactInput } from './session-artifact-index';

export type ArtifactRegistrySource =
  | 'builder'
  | 'upload'
  | 'quick_edit'
  | 'coreview_version'
  | 'file_library_backfill'
  | 'backfill';

export type ArtifactRegistryRole = 'primary' | 'wrapper' | 'support' | 'internal';

export type ArtifactRegistryRecord = {
  artifact_id: string;
  user_id: string;
  thread_id: string;
  session_id?: string | null;
  parent_thread_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  trace_id?: string | null;
  logical_artifact_id: string;
  version_id: string;
  parent_version_id?: string | null;
  title: string;
  filename: string;
  artifact_type: string;
  renderer_kind: ArtifactRendererKind | string;
  mime_type?: string | null;
  safe_summary?: string | null;
  source: ArtifactRegistrySource;
  local_path: string;
  storage_provider: 'local' | 'supabase' | 'hybrid';
  storage_bucket?: string | null;
  storage_object_path?: string | null;
  size_bytes?: number | null;
  content_hash?: string | null;
  storage_status: string;
  artifact_role: ArtifactRegistryRole;
  is_library_visible: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  last_opened_at?: string | null;
  opened_count: number;
  raw_content_excluded: true;
  signed_url_excluded: true;
};

export type ArtifactRegistryListResponse = {
  artifacts: ArtifactRegistryRecord[];
  total: number;
};

export type ArtifactOpenTarget = {
  artifact_id: string;
  thread_id: string;
  session_id?: string | null;
  artifact_path: string;
  renderer_kind: ArtifactRendererKind | string;
  mime_type?: string | null;
  title: string;
  review_room_supported: boolean;
};

export type ArtifactOpenResponse = {
  artifact: ArtifactRegistryRecord;
  canvas_target: ArtifactOpenTarget;
};

export type ArtifactRegistryListFilters = {
  artifactType?: string;
  source?: string;
  threadId?: string;
  sessionId?: string;
  search?: string;
  sort?: 'updated' | 'created' | 'recent' | 'title';
  includeHidden?: boolean;
};

const SOURCE_PRIORITY: Record<ArtifactRegistrySource, number> = {
  builder: 10,
  quick_edit: 20,
  coreview_version: 30,
  upload: 40,
  file_library_backfill: 50,
  backfill: 50,
};

export function buildArtifactRegistryQuery(filters: ArtifactRegistryListFilters): string {
  const params = new URLSearchParams();
  if (filters.artifactType && filters.artifactType !== 'all') {
    params.set('artifact_type', filters.artifactType);
  }
  if (filters.source && filters.source !== 'all') {
    params.set('source', filters.source);
  }
  if (filters.threadId?.trim()) {
    params.set('thread_id', filters.threadId.trim());
  }
  if (filters.sessionId?.trim()) {
    params.set('session_id', filters.sessionId.trim());
  }
  if (filters.search?.trim()) {
    params.set('search', filters.search.trim());
  }
  if (filters.sort) {
    params.set('sort', filters.sort);
  }
  if (filters.includeHidden) {
    params.set('include_hidden', 'true');
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function fetchArtifactRegistryList(
  filters: ArtifactRegistryListFilters,
): Promise<ArtifactRegistryListResponse> {
  const response = await fetch(`/api/artifacts${buildArtifactRegistryQuery(filters)}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`artifact_registry_list_failed:${response.status}`);
  }
  return response.json() as Promise<ArtifactRegistryListResponse>;
}

export async function openArtifactRegistryRecord(artifactId: string): Promise<ArtifactOpenResponse> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/open`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`artifact_registry_open_failed:${response.status}`);
  }
  return response.json() as Promise<ArtifactOpenResponse>;
}

export async function deleteArtifactRegistryRecord(artifactId: string): Promise<ArtifactOpenResponse> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`artifact_registry_delete_failed:${response.status}`);
  }
  return response.json() as Promise<ArtifactOpenResponse>;
}

export function registrySourceToSessionSource(source: ArtifactRegistrySource): ArtifactRegisterSource {
  if (source === 'quick_edit') return 'quick_patch';
  if (source === 'coreview_version') return 'coreview_version';
  if (source === 'file_library_backfill' || source === 'backfill') return 'file_library';
  if (source === 'builder') return 'builder_completion';
  return 'manual';
}

export function artifactRegistryRecordToSessionMetadata(
  record: ArtifactRegistryRecord,
): Partial<Omit<RegisterArtifactInput, 'context' | 'localPath'>> {
  return {
    title: record.title,
    artifactType: record.artifact_type,
    rendererKind: normalizeRendererKind(record.renderer_kind),
    mimeType: record.mime_type ?? null,
    logicalArtifactId: record.logical_artifact_id,
    versionId: record.version_id,
    parentVersionId: record.parent_version_id ?? null,
    taskId: record.task_id ?? null,
    runId: record.run_id ?? null,
    contentHash: record.content_hash ?? null,
    safeSummary: record.safe_summary ?? null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    storageBucket: record.storage_bucket ?? null,
    storageObjectPath: record.storage_object_path ?? null,
    source: registrySourceToSessionSource(record.source),
  };
}

export function normalizeRegistryArtifactPath(value: string | null | undefined): string | null {
  const normalized = normalizeBuilderArtifactPath(value);
  if (!normalized || /^[a-zA-Z]:\//u.test(normalized) || normalized.startsWith('//')) {
    return null;
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.includes('..')) {
    return null;
  }
  if (
    normalized.startsWith('mnt/user-data/outputs/')
    || normalized.startsWith('mnt/user-data/workspace/outputs/')
  ) {
    return normalized;
  }
  return null;
}

export function isArtifactRegistryLibraryVisibleCandidate(input: {
  localPath: string | null | undefined;
  title?: string | null;
  artifactType?: string | null;
  rendererKind?: string | null;
}): boolean {
  const localPath = normalizeRegistryArtifactPath(input.localPath);
  if (!localPath) {
    return false;
  }
  if (isSupportArtifactPath(localPath)) {
    return false;
  }
  const filename = filenameFromPath(localPath).toLowerCase();
  const title = input.title?.toLowerCase() ?? '';
  const rendererKind = input.rendererKind?.toLowerCase() ?? '';
  const artifactType = input.artifactType?.toLowerCase() ?? '';
  const combined = `${title} ${filename} ${localPath.toLowerCase()}`;

  if (rendererKind === 'metadata' || rendererKind === 'unsupported') {
    return false;
  }
  if (artifactType === 'metadata' || artifactType === 'internal') {
    return false;
  }
  if (filename.endsWith('.html') || filename.endsWith('.htm')) {
    if (
      combined.includes('handoff wrapper')
      || combined.includes('artifact wrapper')
      || combined.includes('builder wrapper')
      || combined.includes('render wrapper')
      || combined.includes('preview wrapper')
      || (combined.includes('handoff') && combined.includes('wrapper'))
      || (filename.includes('wrapper') && /(?:render|preview|handoff)/u.test(combined))
    ) {
      return false;
    }
    if (startsWithActionPrefix(filename) && /(?:markdown|\.md| pdf|\.pdf|pptx|\.pptx)/u.test(combined)) {
      return false;
    }
  }
  return true;
}

export function dedupeVisibleArtifactRegistryRecords(
  records: ArtifactRegistryRecord[],
): ArtifactRegistryRecord[] {
  const byIdentity = new Map<string, ArtifactRegistryRecord>();
  for (const record of records) {
    if (!isVisibleRegistryRecord(record)) {
      continue;
    }
    const identity = registryRecordIdentity(record);
    const current = byIdentity.get(identity);
    if (!current) {
      byIdentity.set(identity, record);
      continue;
    }
    byIdentity.set(identity, chooseRegistryRecord(current, record));
  }
  return Array.from(byIdentity.values());
}

export function normalizeRendererKind(value: string | null | undefined): ArtifactRendererKind {
  const normalized = value?.trim() as ArtifactRendererKind | undefined;
  if (
    normalized === 'markdown'
    || normalized === 'html'
    || normalized === 'pdf'
    || normalized === 'image'
    || normalized === 'metadata'
    || normalized === 'download_only'
    || normalized === 'unsupported'
  ) {
    return normalized;
  }
  return 'metadata';
}

function filenameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? 'artifact';
}

function relativeOutputPath(path: string): string | null {
  if (path === 'mnt/user-data/outputs' || path === 'mnt/user-data/workspace/outputs') {
    return '';
  }
  if (path.startsWith('mnt/user-data/outputs/')) {
    return path.slice('mnt/user-data/outputs/'.length);
  }
  if (path.startsWith('mnt/user-data/workspace/outputs/')) {
    return path.slice('mnt/user-data/workspace/outputs/'.length);
  }
  return null;
}

function isVisibleRegistryRecord(record: ArtifactRegistryRecord): boolean {
  if (
    !record.is_library_visible
    || record.deleted_at
    || record.artifact_role !== 'primary'
  ) {
    return false;
  }
  return isArtifactRegistryLibraryVisibleCandidate({
    localPath: record.local_path,
    title: record.title,
    artifactType: record.artifact_type,
    rendererKind: record.renderer_kind,
  });
}

function registryRecordIdentity(record: ArtifactRegistryRecord): string {
  return [
    record.user_id,
    (record.parent_thread_id || record.thread_id || '').trim().toLowerCase(),
    normalizeRegistryArtifactPath(record.local_path) ?? (record.storage_object_path ?? '').trim().toLowerCase(),
    String(record.renderer_kind || '').trim().toLowerCase(),
    String(record.artifact_type || '').trim().toLowerCase(),
  ].join('|');
}

function chooseRegistryRecord(
  left: ArtifactRegistryRecord,
  right: ArtifactRegistryRecord,
): ArtifactRegistryRecord {
  const leftPriority = SOURCE_PRIORITY[left.source] ?? 100;
  const rightPriority = SOURCE_PRIORITY[right.source] ?? 100;
  if (leftPriority !== rightPriority) {
    return mergeRegistryMetadata(leftPriority < rightPriority ? left : right, leftPriority < rightPriority ? right : left);
  }
  const leftUpdatedAt = Date.parse(left.updated_at || '') || 0;
  const rightUpdatedAt = Date.parse(right.updated_at || '') || 0;
  return mergeRegistryMetadata(leftUpdatedAt >= rightUpdatedAt ? left : right, leftUpdatedAt >= rightUpdatedAt ? right : left);
}

function mergeRegistryMetadata(
  selected: ArtifactRegistryRecord,
  fallback: ArtifactRegistryRecord,
): ArtifactRegistryRecord {
  return {
    ...selected,
    safe_summary: selected.safe_summary ?? fallback.safe_summary ?? null,
    mime_type: selected.mime_type ?? fallback.mime_type ?? null,
    size_bytes: selected.size_bytes ?? fallback.size_bytes ?? null,
    content_hash: selected.content_hash ?? fallback.content_hash ?? null,
    storage_bucket: selected.storage_bucket ?? fallback.storage_bucket ?? null,
    storage_object_path: selected.storage_object_path ?? fallback.storage_object_path ?? null,
    last_opened_at: selected.last_opened_at ?? fallback.last_opened_at ?? null,
    opened_count: Math.max(selected.opened_count, fallback.opened_count),
  };
}

function isSupportArtifactPath(path: string): boolean {
  const relative = relativeOutputPath(path);
  if (!relative) {
    return false;
  }
  const parts = relative.split('/').filter(Boolean);
  const firstPart = parts[0]?.toLowerCase();
  const filename = parts.at(-1)?.toLowerCase() ?? '';
  if (firstPart && ['visuals', 'sources', 'source_artifact', '.builder'].includes(firstPart)) {
    return true;
  }
  if (
    filename.endsWith('.source.md')
    || filename.endsWith('.source.html')
    || filename.endsWith('.plan.json')
    || filename.endsWith('.manifest.json')
    || filename.endsWith('.metadata.json')
    || filename.endsWith('.meta.json')
    || filename.endsWith('.diagnostics.json')
  ) {
    return true;
  }
  return (
    (filename.startsWith('_') && /\.(?:py|sh|ps1)$/u.test(filename))
    || (filename.startsWith('test_') && /\.(?:py|sh|ps1)$/u.test(filename))
  );
}

function startsWithActionPrefix(filename: string): boolean {
  return ['build-', 'create-', 'draft-', 'generate-', 'make-', 'render-', 'write-']
    .some((prefix) => filename.startsWith(prefix));
}
