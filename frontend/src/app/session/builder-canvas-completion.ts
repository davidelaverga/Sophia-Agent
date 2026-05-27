import { buildThreadArtifactHref, getBuilderArtifactFiles } from '../lib/builder-artifacts';
import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type { BuilderCanvasTaskSnapshotV1 } from '../types/builder-canvas';
import type { BuilderCompletionEventV1 } from '../types/builder-completion';

function completionStatusFromCanvasStatus(
  status: BuilderCanvasTaskSnapshotV1['status'],
): BuilderCompletionEventV1['status'] | null {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return null;
}

function completionMatchesTask(
  completion: BuilderCompletionEventV1,
  task: BuilderCanvasTaskSnapshotV1,
): boolean {
  return completion.task_id === task.task_id && (completion.run_id ?? task.run_id) === task.run_id;
}

export function completionFromTerminalCanvasTask(
  activeTask: BuilderCanvasTaskSnapshotV1 | null,
  builderArtifact: BuilderArtifactV1 | null,
  threadId?: string | null,
): BuilderCompletionEventV1 | null {
  if (!activeTask) return null;
  if (activeTask.completion && completionMatchesTask(activeTask.completion, activeTask)) {
    return {
      ...activeTask.completion,
      thread_id: activeTask.completion.thread_id || activeTask.parent_thread_id,
      task_id: activeTask.task_id,
      run_id: activeTask.completion.run_id ?? activeTask.run_id,
    };
  }

  const status = completionStatusFromCanvasStatus(activeTask.status);
  if (!status) return null;

  const primaryFile = getBuilderArtifactFiles(builderArtifact)[0] ?? null;
  const artifactUrl = status === 'success'
    ? buildThreadArtifactHref(threadId ?? activeTask.parent_thread_id, primaryFile?.path)
    : null;

  return {
    thread_id: activeTask.parent_thread_id,
    task_id: activeTask.task_id,
    run_id: activeTask.run_id,
    status,
    source: 'builder_canvas_snapshot',
    ...(primaryFile?.path ? { artifact_path: primaryFile.path } : {}),
    ...(artifactUrl ? { artifact_url: artifactUrl } : {}),
    ...(primaryFile?.name ? { artifact_filename: primaryFile.name } : {}),
    ...(builderArtifact?.artifactTitle ? { artifact_title: builderArtifact.artifactTitle } : {}),
    ...(builderArtifact?.artifactType ? { artifact_type: builderArtifact.artifactType } : {}),
    ...(builderArtifact?.companionSummary ? { summary: builderArtifact.companionSummary } : {}),
    ...(builderArtifact?.userNextAction ? { user_next_action: builderArtifact.userNextAction } : {}),
  };
}
