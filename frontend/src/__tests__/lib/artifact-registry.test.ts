import { describe, expect, it } from 'vitest';

import {
  dedupeVisibleArtifactRegistryRecords,
  isArtifactRegistryLibraryVisibleCandidate,
  normalizeRegistryArtifactPath,
  type ArtifactRegistryRecord,
} from '../../app/lib/artifact-registry';

const baseRecord: ArtifactRegistryRecord = {
  artifact_id: 'artifact-builder',
  user_id: 'user-1',
  thread_id: 'thread-1',
  session_id: 'session-1',
  parent_thread_id: null,
  task_id: null,
  run_id: null,
  trace_id: null,
  logical_artifact_id: 'logical-builder',
  version_id: 'logical-builder::v1',
  parent_version_id: null,
  title: 'Explicit HTML Library Test',
  filename: 'explicit-html-library-test.html',
  artifact_type: 'html',
  renderer_kind: 'html',
  mime_type: 'text/html',
  safe_summary: null,
  source: 'builder',
  local_path: 'mnt/user-data/outputs/explicit-html-library-test.html',
  storage_provider: 'local',
  storage_bucket: null,
  storage_object_path: null,
  size_bytes: null,
  content_hash: null,
  storage_status: 'available',
  artifact_role: 'primary',
  is_library_visible: true,
  created_at: '2026-06-01T10:00:00+00:00',
  updated_at: '2026-06-01T10:00:00+00:00',
  deleted_at: null,
  last_opened_at: null,
  opened_count: 0,
  raw_content_excluded: true,
  signed_url_excluded: true,
};

describe('artifact registry library visibility candidates', () => {
  it('keeps requested deliverables visible for backfill', () => {
    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/durable-registry-smoke-markdown.md',
      title: 'Durable registry smoke markdown',
      artifactType: 'markdown',
      rendererKind: 'markdown',
    })).toBe(true);

    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/interactive-launch-page.html',
      title: 'Interactive launch page',
      artifactType: 'webpage',
      rendererKind: 'html',
    })).toBe(true);
  });

  it('skips wrapper and support files during local index backfill', () => {
    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/create-a-real-markdown-artifact-file-nam.html',
      title: 'Durable Artifact Registry Smoke Test - Handoff Wrapper',
      artifactType: 'html',
      rendererKind: 'html',
    })).toBe(false);

    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/visuals/chart.png',
      title: 'Support chart',
      artifactType: 'image',
      rendererKind: 'image',
    })).toBe(false);
  });

  it('dedupes visible builder and backfill registry records with builder priority', () => {
    const backfillRecord: ArtifactRegistryRecord = {
      ...baseRecord,
      artifact_id: 'artifact-backfill',
      logical_artifact_id: 'logical-backfill',
      version_id: 'logical-backfill::v1',
      source: 'file_library_backfill',
      updated_at: '2026-06-02T10:00:00+00:00',
    };

    const visible = dedupeVisibleArtifactRegistryRecords([backfillRecord, baseRecord]);

    expect(visible).toHaveLength(1);
    expect(visible[0]?.artifact_id).toBe('artifact-builder');
    expect(visible[0]?.source).toBe('builder');
  });

  it('filters hidden wrappers and unsafe registry paths', () => {
    const wrapperRecord: ArtifactRegistryRecord = {
      ...baseRecord,
      artifact_id: 'artifact-wrapper',
      title: 'Durable Artifact Registry Smoke Test - Handoff Wrapper',
      filename: 'create-a-real-markdown-artifact-file-nam.html',
      local_path: 'mnt/user-data/outputs/create-a-real-markdown-artifact-file-nam.html',
      source: 'backfill',
    };
    const unsafeRecord: ArtifactRegistryRecord = {
      ...baseRecord,
      artifact_id: 'artifact-unsafe',
      local_path: 'mnt/user-data/outputs/../secret.html',
    };

    expect(dedupeVisibleArtifactRegistryRecords([wrapperRecord, unsafeRecord, baseRecord])).toEqual([baseRecord]);
    expect(normalizeRegistryArtifactPath('C:/Users/alice/secret.html')).toBeNull();
    expect(normalizeRegistryArtifactPath('outputs/../secret.html')).toBeNull();
  });
});
