import { describe, expect, it } from 'vitest';

import { completionFromTerminalCanvasTask } from '../../app/session/builder-canvas-completion';
import type { BuilderArtifactV1 } from '../../app/types/builder-artifact';
import type { BuilderCanvasTaskSnapshotV1 } from '../../app/types/builder-canvas';

describe('completionFromTerminalCanvasTask', () => {
  const terminalTask: BuilderCanvasTaskSnapshotV1 = {
    parent_thread_id: 'thread-1',
    task_id: 'task-1',
    run_id: 'run-1',
    status: 'completed',
  };

  it('preserves a matching completion payload from the active task', () => {
    const completion = completionFromTerminalCanvasTask({
      ...terminalTask,
      completion: {
        thread_id: 'thread-1',
        task_id: 'task-1',
        run_id: 'run-1',
        status: 'success',
        artifact_url: '/ready.md',
      },
    }, null, 'thread-1');

    expect(completion).toEqual(expect.objectContaining({
      task_id: 'task-1',
      run_id: 'run-1',
      status: 'success',
      artifact_url: '/ready.md',
    }));
  });

  it('synthesizes a success completion from terminal snapshot state and stored artifact data', () => {
    const artifact: BuilderArtifactV1 = {
      artifactPath: 'mnt/user-data/outputs/brief.md',
      artifactTitle: 'Launch brief',
      artifactType: 'document',
      decisionsMade: [],
      companionSummary: 'A concise launch brief is ready.',
      userNextAction: 'Open the brief.',
    };

    const completion = completionFromTerminalCanvasTask(terminalTask, artifact, 'thread-1');

    expect(completion).toEqual(expect.objectContaining({
      thread_id: 'thread-1',
      task_id: 'task-1',
      run_id: 'run-1',
      status: 'success',
      artifact_title: 'Launch brief',
      artifact_type: 'document',
      artifact_filename: 'brief.md',
      artifact_path: 'mnt/user-data/outputs/brief.md',
      artifact_url: '/api/threads/thread-1/artifacts/mnt/user-data/outputs/brief.md',
      summary: 'A concise launch brief is ready.',
      user_next_action: 'Open the brief.',
    }));
  });

  it('does not synthesize completion for a running canvas task', () => {
    const completion = completionFromTerminalCanvasTask({
      ...terminalTask,
      status: 'running',
    }, null, 'thread-1');

    expect(completion).toBeNull();
  });

  it('synthesizes timeout completion from timed-out terminal snapshot state', () => {
    const completion = completionFromTerminalCanvasTask({
      ...terminalTask,
      status: 'timed_out',
    }, null, 'thread-1');

    expect(completion).toEqual(expect.objectContaining({
      thread_id: 'thread-1',
      task_id: 'task-1',
      run_id: 'run-1',
      status: 'timeout',
      source: 'builder_canvas_snapshot',
    }));
  });
});
