import type { BuilderCompletionEventV1 } from './builder-completion';

export type BuilderCanvasStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type BuilderCanvasActivity =
  | {
    kind: 'phase';
    phase: 'starting' | 'researching' | 'drafting' | 'finalizing';
    label: string;
  }
  | {
    kind: 'tool_activity';
    category: 'research' | 'draft' | 'render' | 'package' | 'finalize';
    label: string;
  };

export type BuilderCanvasEventV1 = {
  version: 1;
  event_id: string;
  sequence: number;
  parent_thread_id: string;
  task_id: string;
  run_id: string;
  occurred_at: string;
  kind: 'progress' | 'terminal';
  status: BuilderCanvasStatus;
  activity?: BuilderCanvasActivity;
  completion?: BuilderCompletionEventV1;
};

export type BuilderCanvasTaskSnapshotV1 = {
  parent_thread_id: string;
  task_id: string;
  run_id: string;
  status: BuilderCanvasStatus;
  latest_activity?: BuilderCanvasActivity;
  completion?: BuilderCompletionEventV1;
};

export type BuilderCanvasSnapshotV1 = {
  version: 1;
  active_task: BuilderCanvasTaskSnapshotV1 | null;
  recent_events: BuilderCanvasEventV1[];
};
