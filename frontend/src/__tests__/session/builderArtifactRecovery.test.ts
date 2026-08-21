import { describe, expect, it } from 'vitest';

import type { ArtifactRecord } from '../../app/lib/session-artifact-index';
import { findBuilderTaskArtifactRecord } from '../../app/session/builderArtifactRecovery';
import type { BuilderTaskV1 } from '../../app/types/builder-task';

const runningTask: BuilderTaskV1 = {
  phase: 'running',
  taskId: 'task-1',
  runId: 'run-1',
  startedAt: '2026-08-21T08:00:00.000Z',
};

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: 'artifact-1',
    stableArtifactIdentity: 'stable-1',
    logicalArtifactId: 'logical-1',
    versionId: 'version-1',
    threadId: 'thread-1',
    parentThreadId: 'thread-1',
    taskId: 'task-1',
    runId: 'run-1',
    title: 'Presentation',
    filename: 'presentation.pdf',
    artifactType: 'pdf',
    rendererKind: 'pdf',
    localPath: 'mnt/user-data/outputs/presentation.pdf',
    storageProvider: 'supabase',
    createdAt: '2026-08-21T08:10:00.000Z',
    updatedAt: '2026-08-21T08:11:00.000Z',
    rawContentExcluded: true,
    ...overrides,
  };
}

describe('findBuilderTaskArtifactRecord', () => {
  it('lets an exact durable task/run artifact overrule a stale running card', () => {
    const record = artifact();

    expect(findBuilderTaskArtifactRecord([record], runningTask)).toBe(record);
  });

  it('rejects a populated run-id conflict even when the task id matches', () => {
    expect(findBuilderTaskArtifactRecord([
      artifact({ runId: 'run-other' }),
    ], runningTask)).toBeNull();
  });

  it('rejects an older artifact whose metadata was touched by a newer task', () => {
    expect(findBuilderTaskArtifactRecord([
      artifact({
        createdAt: '2026-08-21T07:30:00.000Z',
        updatedAt: '2026-08-21T08:12:00.000Z',
      }),
    ], runningTask)).toBeNull();
  });

  it('rejects artifacts marked missing and terminal tasks', () => {
    expect(findBuilderTaskArtifactRecord([
      artifact({ review: { missing: true } }),
    ], runningTask)).toBeNull();
    expect(findBuilderTaskArtifactRecord([
      artifact(),
    ], { ...runningTask, phase: 'completed' })).toBeNull();
  });
});
