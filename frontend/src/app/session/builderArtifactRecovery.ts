import type { ArtifactRecord } from '../lib/session-artifact-index';
import type { BuilderTaskV1 } from '../types/builder-task';

const ARTIFACT_CLOCK_SKEW_MS = 60_000;

function normalizedIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesTaskIdentity(record: ArtifactRecord, task: BuilderTaskV1): boolean {
  const taskId = normalizedIdentity(task.taskId);
  const runId = normalizedIdentity(task.runId);
  const recordTaskId = normalizedIdentity(record.taskId);
  const recordRunId = normalizedIdentity(record.runId);

  if (taskId && recordTaskId && taskId !== recordTaskId) {
    return false;
  }
  if (runId && recordRunId && runId !== recordRunId) {
    return false;
  }
  return Boolean(
    (taskId && recordTaskId === taskId)
    || (runId && recordRunId === runId),
  );
}

function wasCreatedForTask(record: ArtifactRecord, task: BuilderTaskV1): boolean {
  const startedAt = timestamp(task.startedAt);
  if (startedAt === null) {
    return true;
  }
  const createdAt = timestamp(record.createdAt);
  return createdAt !== null && createdAt >= startedAt - ARTIFACT_CLOCK_SKEW_MS;
}

/**
 * Find a durable artifact that can safely overrule a stale running card.
 *
 * Exact task/run identity is mandatory and any populated conflict rejects the
 * record. The creation-time guard prevents an older persisted artifact whose
 * metadata was accidentally touched by a newer run from completing that run.
 */
export function findBuilderTaskArtifactRecord(
  records: ArtifactRecord[],
  task: BuilderTaskV1 | null | undefined,
): ArtifactRecord | null {
  if (task?.phase !== 'running') {
    return null;
  }

  const matches = records.filter((record) => (
    !record.review?.missing
    && matchesTaskIdentity(record, task)
    && wasCreatedForTask(record, task)
  ));
  matches.sort((left, right) => (
    (timestamp(right.updatedAt) ?? 0) - (timestamp(left.updatedAt) ?? 0)
  ));
  return matches[0] ?? null;
}
